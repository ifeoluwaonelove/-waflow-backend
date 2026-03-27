'use strict';
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const fs = require('fs');
const path = require('path');
// Force all models to register before any other service starts
require('./src/models/index'); 

const connectDB = require('./src/config/database');
const { initWhatsApp } = require('./src/whatsapp/engine');
const { startScheduler } = require('./src/services/schedulerService');
const { formatResponse } = require('./src/utils/response');

// ── Ensure sessions dir exists ───────────────────────────────────────────────
const sessionsDir = process.env.WA_SESSIONS_DIR || './sessions';
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

const logsDir = './logs';
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.set('io', io);

// ── Security & Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
}));

app.use(cors({
  origin: function (origin, callback) {
    const allowed = [
      process.env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5173',
    ].filter(Boolean);
    if (!origin || allowed.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(mongoSanitize());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json(
    formatResponse(false, 'Too many requests. Please try again later.')
  ),
});
app.use('/api/', limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/health',     require('./src/routes/health'));
app.use('/api/auth',       require('./src/routes/auth'));
app.use('/api/whatsapp',   require('./src/routes/whatsapp'));
app.use('/api/contacts',   require('./src/routes/contacts'));
app.use('/api/broadcast',  require('./src/routes/broadcast'));
app.use('/api/auto-reply', require('./src/routes/autoReply'));
app.use('/api/referral',   require('./src/routes/referral'));
app.use('/api/analytics',  require('./src/routes/analytics'));
app.use('/api/webhook',    require('./src/routes/webhook'));
// ── New feature routes ────────────────────────────────────────────────────────
app.use('/api/schedule',   require('./src/routes/schedule'));
app.use('/api/invoices',   require('./src/routes/invoices'));
app.use('/api/finance',    require('./src/routes/finance'));
app.use('/api/groups',     require('./src/routes/groups'));
app.use('/api/settings',   require('./src/routes/settings'));
// ── Affiliate referral system ─────────────────────────────────────────────────
app.use('/api/affiliate',  require('./src/routes/affiliate'));
app.use('/api/admin',      require('./src/routes/admin'));
app.use('/api/contests',   require('./src/routes/contests'));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json(formatResponse(false, `Route ${req.originalUrl} not found`));
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const msg = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;
  console.error(`[Error] ${err.stack || err.message}`);
  res.status(status).json(formatResponse(false, msg));
});

// ── Socket.IO events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('join-user-room', (userId) => {
    socket.join(`user-${userId}`);
  });
  socket.on('disconnect', () => {});
});

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT) || 5000;

async function start() {
  try {
    await connectDB();

    // Restore WhatsApp sessions for all connected users
    await initWhatsApp(io);

    // Cron scheduler for broadcasts
    startScheduler();

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`[Server] WAFlow running on port ${PORT} (${process.env.NODE_ENV})`);
    });
  } catch (err) {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err);
  // Don't crash — log and continue (Baileys can throw non-fatal errors)
});

start();

module.exports = { app, io };
