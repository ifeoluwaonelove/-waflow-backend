'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { sessions } = require('../whatsapp/engine');
const router = express.Router();

router.get('/', (req, res) => {
  const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    database: dbState[mongoose.connection.readyState] || 'unknown',
    activeSessions: sessions.size,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB',
    },
  });
});

module.exports = router;
