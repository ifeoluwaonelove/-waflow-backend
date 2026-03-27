'use strict';
/**
 * WAFlow WhatsApp Engine
 * Built on @whiskeysockets/baileys
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
} = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const User = require('../models/User');
const Contact = require('../models/Contact');
const { Message, AutoReply, ReferralParticipant, Contest } = require('../models');

// ── State ─────────────────────────────────────────────────────────────────────
const sessions = new Map();          
const reconnectTimers = new Map();   
const contactCounters = new Map();   

const SESSIONS_DIR = path.resolve(process.env.WA_SESSIONS_DIR || './sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
const jidToPhone = (jid) => '+' + jid.replace(/@s\.whatsapp\.net|@c\.us|@g\.us/g, '').split(':')[0];

function sessionPath(userId) {
  return path.join(SESSIONS_DIR, `user_${userId}`);
}

async function nextContactNum(userId) {
  const n = (contactCounters.get(userId) || 0) + 1;
  contactCounters.set(userId, n);
  return String(n).padStart(3, '0');
}

function messageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''
  );
}

const settingsCache = new Map(); 

async function getUserSettings(userId) {
  if (settingsCache.has(userId)) return settingsCache.get(userId);
  try {
    const { UserSettings } = require('../models');
    let s = await UserSettings.findOne({ userId });
    if (!s) s = await UserSettings.create({ userId });
    settingsCache.set(userId, s);
    setTimeout(() => settingsCache.delete(userId), 60000);
    return s;
  } catch (e) {
    return { autoSaveContacts: true, autoSavePrefix: 'Customer', sendWelcome: true, welcomeMessage: 'Hello 👋\n\nWelcome!', welcomeDelayMs: 1000 };
  }
}

// ── Main Message Handler ──────────────────────────────────────────────────────
async function handleIncomingMessage(userId, m, sock, io) {
  const jid = m.key.remoteJid;
  if (!jid || isJidBroadcast(jid)) return;

  const text = messageText(m);
  const phone = jidToPhone(jid);
  const pushName = m.pushName || 'Customer';

  try {
    // 1. Auto-save contact
    const contact = await autoSaveContact(userId, jid, pushName);
    if (!contact) return;

    // 2. Save Message to DB
    await Message.create({
      userId,
      contactId: contact._id,
      whatsappMessageId: m.key.id,
      body: text,
      type: 'inbound',
      status: 'delivered'
    });

    // 3. Referral/Contest Logic
    const { handleContestCommand } = require('../services/contestCommandHandler');
    await handleContestCommand(userId, phone, text, sock, io);

    // 4. Auto-Reply Logic
    const replyRule = await matchAutoReply(userId, text);
    if (replyRule) {
        setTimeout(async () => {
            await sock.sendMessage(jid, { text: replyRule.response });
            await Message.create({
                userId,
                contactId: contact._id,
                body: replyRule.response,
                type: 'outbound',
                status: 'sent'
            });
        }, 1000);
    }

    // 5. Emit to Frontend
    io.to(`user-${userId}`).emit('whatsapp:message', {
      contact: { id: contact._id, name: contact.displayName, phone },
      message: { text, timestamp: Date.now() },
    });

  } catch (err) {
    console.error('[WA] Message processing error:', err.message);
  }
}

// ── Auto-save contact ─────────────────────────────────────────────────────────
async function autoSaveContact(userId, jid, pushName) {
  const phone    = jidToPhone(jid);
  const settings = await getUserSettings(userId);
  try {
    let contact = await Contact.findOne({ userId, phone });
    if (!contact) {
      if (!settings.autoSaveContacts) return null;
      const num  = await nextContactNum(userId);
      const prefix = settings.autoSavePrefix || 'Customer';
      contact = await Contact.create({
        userId,
        phone,
        whatsappName: pushName,
        generatedName: `${prefix} ${num}`,
        displayName: pushName || `${prefix} ${num}`,
      });
    }
    return contact;
  } catch (err) {
    return null;
  }
}

async function matchAutoReply(userId, text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  try {
    const rules = await AutoReply.find({ userId, status: 'active' });
    for (const rule of rules) {
        const matched = rule.keywords.some(kw => lower.includes(kw.toLowerCase()));
        if (matched) return rule;
    }
  } catch (err) {}
  return null;
}

// ── Create Session ────────────────────────────────────────────────────────────
async function createSession(userId, io, forceNew = false) {
  if (reconnectTimers.has(userId)) {
    clearTimeout(reconnectTimers.get(userId));
    reconnectTimers.delete(userId);
  }

  const sPath = sessionPath(userId);
  const { state, saveCreds } = await useMultiFileAuthState(sPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['WAFlow', 'Chrome', '1.0.0'],
  });

  sessions.set(userId, sock);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      const url = await QRCode.toDataURL(qr);
      io.to(`user-${userId}`).emit('whatsapp:qr', { qr: url });
    }

    if (connection === 'open') {
      await User.findByIdAndUpdate(userId, { whatsappConnected: true, whatsappNumber: jidToPhone(sock.user.id), whatsappName: sock.user.name });
      io.to(`user-${userId}`).emit('whatsapp:connected', { number: sock.user.id });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        reconnectTimers.set(userId, setTimeout(() => createSession(userId, io), 5000));
      } else {
        await User.findByIdAndUpdate(userId, { whatsappConnected: false });
        io.to(`user-${userId}`).emit('whatsapp:disconnected');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const m of messages) {
        if (!m.key.fromMe) {
          await handleIncomingMessage(userId, m, sock, io);
        }
      }
    }
  });

  return sock;
}

module.exports = { createSession, sessions };
