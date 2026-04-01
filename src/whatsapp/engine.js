'use strict';
/**
 * WAFlow WhatsApp Engine
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
const { createExpenseFromMessage } = require('../services/expenseService');
const { generateInvoiceFromMessage } = require('../services/invoiceService');
const Contact = require('../models/Contact');
const { saveSession, getSession, revokeSession } = require('../services/sessionService');
const { Message, AutoReply, ReferralParticipant, Contest } = require('../models');
const { handleContestCommand }  = require('../services/contestCommandHandler');

// ── State ─────────────────────────────────────────────────────────────────────
const sessions = new Map();
const reconnectTimers = new Map();
const contactCounters = new Map();

const SESSIONS_DIR = path.resolve(process.env.WA_SESSIONS_DIR || './sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────
const jidToPhone = (jid) =>
  '+' + jid.replace(/@s\.whatsapp\.net|@c\.us/g, '');

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

// ── Get or create user settings ─────────────────────────────────────────────
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
    return { autoSaveContacts: true, autoSavePrefix: 'Customer', sendWelcome: true, welcomeMessage: 'Hello 👋\n\nWelcome! How can we help you today?', welcomeDelayMs: 1000 };
  }
}

// ── Auto-save contact ─────────────────────────────────────────────────────────
async function autoSaveContact(userId, jid, pushName) {
  const phone = jidToPhone(jid);
  const settings = await getUserSettings(userId);

  try {
    let contact = await Contact.findOne({ userId, phone });
    if (!contact) {
      if (!settings.autoSaveContacts) return null;
      const num = await nextContactNum(userId);
      const prefix = settings.autoSavePrefix || 'Customer';
      contact = await Contact.create({
        userId,
        phone,
        whatsappName: pushName || null,
        generatedName: `${prefix} ${num}`,
        displayName: pushName || `${prefix} ${num}`,
        firstMessageAt: new Date(),
      });
    } else if (pushName && !contact.whatsappName) {
      contact.whatsappName = pushName;
      contact.displayName = contact.name || pushName || contact.generatedName;
      await contact.save();
    }
    return contact;
  } catch (err) {
    console.error('[WA] autoSaveContact error:', err.message);
    return null;
  }
}

// ── Auto-reply ────────────────────────────────────────────────────────────────
async function matchAutoReply(userId, text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  try {
    const rules = await AutoReply.find({ userId, status: 'active' }).sort({ priority: -1 });
    for (const rule of rules) {
      if (rule.timeRestriction !== 'always') {
        const now = new Date();
        const [sh, sm] = rule.businessHoursStart.split(':').map(Number);
        const [eh, em] = rule.businessHoursEnd.split(':').map(Number);
        const cur = now.getHours() * 60 + now.getMinutes();
        const inBiz = cur >= sh * 60 + sm && cur <= eh * 60 + em;
        if (rule.timeRestriction === 'business_hours' && !inBiz) continue;
        if (rule.timeRestriction === 'off_hours' && inBiz) continue;
      }
      const matched = rule.keywords.some((kw) => {
        switch (rule.matchType) {
          case 'exact': return lower === kw;
          case 'starts_with': return lower.startsWith(kw);
          default: return lower.includes(kw);
        }
      });
      if (matched) {
        rule.triggerCount = (rule.triggerCount || 0) + 1;
        await rule.save();
        return rule;
      }
    }
  } catch (err) {
    console.error('[WA] matchAutoReply error:', err.message);
  }
  return null;
}

// ── Referral detection ────────────────────────────────────────────────────────
async function detectReferral(userId, phone, text) {
  if (!text) return;
  const match = text.match(/REF[A-Z0-9]{3,10}/i);
  if (!match) return;
  const code = match[0].toUpperCase();
  try {
    const contest = await Contest.findOne({ userId, status: 'active' });
    if (!contest) return;
    const exists = await ReferralParticipant.findOne({ contestId: contest._id, phone });
    if (exists) return;
    const referrer = await ReferralParticipant.findOne({ contestId: contest._id, referralCode: code });
    await ReferralParticipant.create({
      contestId: contest._id,
      userId,
      phone,
      name: phone,
      referralCode: `REF${Date.now().toString(36).toUpperCase()}`,
      referredBy: code,
      referrerId: referrer?._id || null,
    });
    if (referrer) {
      await ReferralParticipant.findByIdAndUpdate(referrer._id, { $inc: { totalReferrals: 1 } });
    }
  } catch (err) {
    console.error('[WA] detectReferral error:', err.message);
  }
}

// ── Shared incoming-message handler ──────────────────────────────────────────
// Called by BOTH createSession (QR) and createSessionWithPairing so that
// auto-replies, contact saving, and real-time events work regardless of how
// the user connected.
async function handleIncomingMessage(sock, userId, io, msg) {
  try {
    if (!msg) return;
    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid || !jid.includes('@s.whatsapp.net')) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    if (!text) return;

    console.log('[WA] 📩 Incoming message:', text);

    const phone = jidToPhone(jid);

    // ── Auto-save contact if new ────────────────────────────────────────────
    let contact = await Contact.findOne({ userId, phone });
    if (!contact) {
      console.log('[WA] New contact, saving...');
      contact = await Contact.create({
        userId,
        phone,
        displayName: msg.pushName || phone,
        isActive: true,
        firstMessageAt: new Date(),
      });

      // Send welcome message from user settings (falls back to default)
      const settings = await getUserSettings(userId);
      if (settings.sendWelcome !== false) {
        const welcomeText = settings.welcomeMessage || 'Welcome! Thanks for contacting us.';
        const delay = settings.welcomeDelayMs ?? 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
        await sock.sendMessage(jid, { text: welcomeText });
        console.log('[WA] Welcome message sent');

        await Message.create({
          userId,
          contactId: contact._id,
          phone,
          direction: 'outbound',
          body: welcomeText,
          status: 'sent',
          timestamp: new Date(),
        });
      }
      return;
    }

    // ── Update contact stats ────────────────────────────────────────────────
    await Contact.findByIdAndUpdate(contact._id, {
      $inc: { totalMessages: 1 },
      lastMessageAt: new Date(),
    });

    // ── Log inbound message ─────────────────────────────────────────────────
    await Message.create({
      userId,
      contactId: contact._id,
      phone,
      direction: 'inbound',
      body: text,
      type: Object.keys(msg.message || {})[0]?.replace('Message', '') || 'text',
      whatsappMessageId: msg.key.id,
      timestamp: new Date(),
      status: 'received',
    });

    // ── Emit real-time event to frontend ────────────────────────────────────
    io.to(`user-${userId}`).emit('whatsapp:message', {
      contact: { id: contact._id, name: contact.displayName, phone },
      message: { text, timestamp: Date.now() },
    });

    // ── Load auto-reply rules ───────────────────────────────────────────────
    const rules = await AutoReply.find({ userId, status: 'active' }).sort({ priority: -1 });
    console.log(`[WA] Loaded ${rules.length} active auto-reply rules`);

    // ── Spam guard: 15-second cooldown per contact ──────────────────────────
    const recentReply = await Message.findOne({
      userId,
      phone,
      direction: 'outbound',
      autoReplyId: { $ne: null },
      createdAt: { $gte: new Date(Date.now() - 15000) },
    });

    if (recentReply) {
      console.log('[WA] Skipping auto-reply — cooldown active');
      return;
    }

    // ── Find first matching rule ────────────────────────────────────────────
    let matchedRule = null;
    for (const rule of rules) {
      const lower = text.toLowerCase();
      const matched = rule.keywords.some(keyword => {
        switch (rule.matchType) {
          case 'exact':       return lower === keyword.toLowerCase();
          case 'starts_with': return lower.startsWith(keyword.toLowerCase());
          default:            return lower.includes(keyword.toLowerCase());
        }
      });
      if (matched) {
        matchedRule = rule;
        console.log(`[WA] ✅ MATCHED rule: "${rule.name}"`);
        break;
      }
    }

    if (!matchedRule) {
      console.log('[WA] ❌ No rule matched for:', text);
      return;
    }

    // ── Time-restriction check ──────────────────────────────────────────────
    if (matchedRule.timeRestriction !== 'always') {
      const now = new Date();
      const [sh, sm] = (matchedRule.businessHoursStart || '09:00').split(':').map(Number);
      const [eh, em] = (matchedRule.businessHoursEnd   || '18:00').split(':').map(Number);
      const cur   = now.getHours() * 60 + now.getMinutes();
      const inBiz = cur >= sh * 60 + sm && cur <= eh * 60 + em;

      if (matchedRule.timeRestriction === 'business_hours' && !inBiz) {
        console.log('[WA] Rule skipped — outside business hours');
        return;
      }
      if (matchedRule.timeRestriction === 'off_hours' && inBiz) {
        console.log('[WA] Rule skipped — inside business hours');
        return;
      }
    }

    // ── Send auto-reply ─────────────────────────────────────────────────────
    const delay = matchedRule.delayMs ?? 1000;
    console.log(`[WA] Sending auto-reply after ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));

    await sock.sendMessage(jid, { text: matchedRule.reply });
    console.log('[WA] ✅ Auto-reply sent successfully');

    // ── Persist outbound message & update rule stats ────────────────────────
    await Message.create({
      userId,
      contactId: contact._id,
      phone,
      direction: 'outbound',
      body: matchedRule.reply,
      autoReplyId: matchedRule._id,
      status: 'sent',
      timestamp: new Date(),
    });

    matchedRule.triggerCount = (matchedRule.triggerCount || 0) + 1;
    await matchedRule.save();

  } catch (err) {
    console.error('[WA] Message processing error:', err);
  }
}

// ── PAIRING CODE METHOD (NEW) ────────────────────────────────────────────────
async function createSessionWithPairing(userId, phoneNumber, io) {
  if (sessions.has(userId)) {
    try { sessions.get(userId).end(); } catch (_) {}
    sessions.delete(userId);
  }
  
  const sPath = sessionPath(userId);
  if (fs.existsSync(sPath)) {
    fs.rmSync(sPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sPath, { recursive: true });
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
      version,
      auth: state,
      browser: ['WAFlow', 'Chrome', '120.0.0.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
      getMessage: async () => ({ conversation: '' }),
    });
    
    sessions.set(userId, sock);
    
    // Listen for QR and pairing code
    sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        console.log('[WA] QR code generated as backup');
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
        io.to(`user-${userId}`).emit('whatsapp:qr', { qr: qrDataUrl });
      }
      
      if (connection === 'open') {
        const phone = sock.user?.id ? jidToPhone(sock.user.id) : null;
        const pushName = sock.user?.name || null;
        
        await User.findByIdAndUpdate(userId, {
          whatsappConnected: true,
          whatsappPhone: phone,
          whatsappName: pushName,
          whatsappPushName: pushName,
          whatsappSessionPath: sPath,
        });
        
        io.to(`user-${userId}`).emit('whatsapp:connected', { phone, name: pushName });
        console.log(`[WA] User ${userId} connected — ${pushName || phone}`);
      }
      
      if (connection === 'close') {
        sessions.delete(userId);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          console.log(`[WA] Disconnected, code: ${code}`);
        }
      }
    });
    
    sock.ev.on('creds.update', saveCreds);

    // ── Incoming message handler (shared with QR method) ────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
      await handleIncomingMessage(sock, userId, io, messages[0]);
    });
    
    // Request pairing code
    if (!state.creds.registered) {
      console.log(`[WA] Requesting pairing code for ${phoneNumber}...`);
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`[WA] Pairing code: ${code}`);
        io.to(`user-${userId}`).emit('whatsapp:pairing_code', { code });
      } catch (err) {
        console.error('[WA] Failed to get pairing code:', err);
      }
    }
    
    return sock;
  } catch (err) {
    console.error(`[WA] Pairing error for user ${userId}:`, err.message);
    throw err;
  }
}

// ── Send message ──────────────────────────────────────────────────────────────
async function sendMessage(userId, phone, text, media, mediaType) {
  const sock = sessions.get(userId);
  if (!sock) throw new Error('WhatsApp not connected for this account');

  const jid = phone.replace('+', '') + '@s.whatsapp.net';

  if (media && mediaType) {
    return sock.sendMessage(jid, { [mediaType]: media, caption: text });
  }
  return sock.sendMessage(jid, { text });
}

// ── Disconnect ────────────────────────────────────────────────────────────────
async function disconnectSession(userId) {
  if (reconnectTimers.has(userId)) {
    clearTimeout(reconnectTimers.get(userId));
    reconnectTimers.delete(userId);
  }
  
  const sock = sessions.get(userId);
  const phone = sock?.user?.id ? jidToPhone(sock.user.id) : null;
  
  if (sock) {
    try { await sock.logout(); } catch (_) {}
    sessions.delete(userId);
  }
  
  if (phone && userId) {
    try {
      await revokeSession(userId, phone, 'user_disconnect');
      console.log(`[Session] Revoked session for ${phone}`);
    } catch (err) {
      console.error('[Session] Revoke error:', err.message);
    }
  }
  
  const sPath = sessionPath(userId);
  if (fs.existsSync(sPath)) {
    try { fs.rmSync(sPath, { recursive: true }); } catch (_) {}
  }
  
  await User.findByIdAndUpdate(userId, {
    whatsappConnected: false,
    whatsappPhone: null,
    whatsappName: null,
    whatsappPushName: null,
    whatsappSessionPath: null,
  });
}

// ── Init: restore all connected users on boot ─────────────────────────────────
async function initWhatsApp(io) {
  let users = [];
  try {
    users = await User.find({ whatsappConnected: true }).lean();
  } catch (err) {
    console.error('[WA] initWhatsApp DB query error:', err.message);
    return;
  }

  console.log(`[WA] Restoring ${users.length} session(s)...`);
  for (const user of users) {
    const sPath = sessionPath(user._id.toString());
    if (fs.existsSync(sPath)) {
      createSession(user._id.toString(), io).catch((err) => {
        console.error(`[WA] Failed to restore session for ${user._id}:`, err.message);
      });
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      await User.findByIdAndUpdate(user._id, { whatsappConnected: false, whatsappPhone: null });
    }
  }
}

async function getAllGroupMembers(userId, groupId) {
  const sock = sessions.get(userId);
  if (!sock) throw new Error('WhatsApp not connected');

  try {
    const groupMetadata = await sock.groupMetadata(groupId);
    const allMembers = groupMetadata.participants.map(p => ({
      id: p.id,
      name: p.name || null,
      phone: p.id.split('@')[0],
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin'
    }));
    console.log(`[Group Extract] Extracted ${allMembers.length} members from ${groupMetadata.subject}`);
    return allMembers;
  } catch (err) {
    console.error('[Group Extract] Error:', err);
    throw err;
  }
}

// ── QR CODE METHOD (BACKUP) ───────────────────────────────────────────────────
async function createSession(userId, io, forceNew = false) {
  if (reconnectTimers.has(userId)) {
    clearTimeout(reconnectTimers.get(userId));
    reconnectTimers.delete(userId);
  }

  if (forceNew && sessions.has(userId)) {
    try { sessions.get(userId).end(); } catch (_) {}
    sessions.delete(userId);
  }

  if (sessions.has(userId) && !forceNew) {
    return sessions.get(userId);
  }

  const sPath = sessionPath(userId);
  if (!fs.existsSync(sPath)) fs.mkdirSync(sPath, { recursive: true });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      browser: ['WAFlow', 'Chrome', '120.0.0.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
      getMessage: async () => ({ conversation: '' }),
    });

    sessions.set(userId, sock);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
        io.to(`user-${userId}`).emit('whatsapp:qr', { qr: qrDataUrl });
      }

      if (connection === 'open') {
        const phone = sock.user?.id ? jidToPhone(sock.user.id) : null;
        const pushName = sock.user?.name || null;
        
        await User.findByIdAndUpdate(userId, {
          whatsappConnected: true,
          whatsappPhone: phone,
          whatsappName: pushName,
          whatsappPushName: pushName,
          whatsappSessionPath: sPath,
        });
        io.to(`user-${userId}`).emit('whatsapp:connected', { phone, name: pushName });
        console.log(`[WA] User ${userId} connected — ${pushName || phone}`);
      }

      if (connection === 'close') {
        sessions.delete(userId);
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        if (loggedOut) {
          await User.findByIdAndUpdate(userId, { whatsappConnected: false, whatsappPhone: null });
          io.to(`user-${userId}`).emit('whatsapp:disconnected', { reason: 'logged_out' });
          try { fs.rmSync(sPath, { recursive: true }); } catch (_) {}
          console.log(`[WA] User ${userId} logged out`);
        } else {
          io.to(`user-${userId}`).emit('whatsapp:reconnecting', {});
          console.log(`[WA] User ${userId} disconnected — reconnecting in 5s`);
          const timer = setTimeout(() => createSession(userId, io), 5000);
          reconnectTimers.set(userId, timer);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Incoming message handler (shared with pairing method) ───────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
      await handleIncomingMessage(sock, userId, io, messages[0]);
    });

    return sock;
  } catch (err) {
    console.error(`[WA] createSession error for user ${userId}:`, err.message);
    const timer = setTimeout(() => createSession(userId, io), 8000);
    reconnectTimers.set(userId, timer);
  }
}

module.exports = { createSession, createSessionWithPairing, disconnectSession, sendMessage, initWhatsApp, sessions, getAllGroupMembers };