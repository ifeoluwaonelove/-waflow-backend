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
const { Message, AutoReply, Contest, ContestParticipant } = require('../models'); // BUG FIX 1: was importing ReferralParticipant which doesn't exist; use ContestParticipant
const { handleContestCommand } = require('../services/contestCommandHandler');

// ── State ────────────────────────────────────────────────────────────────────
const sessions       = new Map();
const reconnectTimers = new Map();
const contactCounters = new Map();

// BUG FIX 2: Per-contact cooldown map in memory (avoids DB race conditions)
const autoReplyCooldowns = new Map(); // key: `${userId}:${phone}` → timestamp

const SESSIONS_DIR = path.resolve(process.env.WA_SESSIONS_DIR || './sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// BUG FIX 3: messageText helper was defined but not used inside handleIncomingMessage;
// now used consistently everywhere text needs to be extracted.
function messageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    msg.message?.listResponseMessage?.title ||
    ''
  );
}

// ── Settings cache ────────────────────────────────────────────────────────────
const settingsCache = new Map();

async function getUserSettings(userId) {
  if (settingsCache.has(userId)) return settingsCache.get(userId);
  try {
    const { UserSettings } = require('../models');
    let s = await UserSettings.findOne({ userId });
    if (!s) s = await UserSettings.create({ userId });
    settingsCache.set(userId, s);
    setTimeout(() => settingsCache.delete(userId), 60_000);
    return s;
  } catch (e) {
    return {
      autoSaveContacts: true,
      autoSavePrefix: 'Customer',
      sendWelcome: true,
      welcomeMessage: 'Hello!\n\nWelcome! How can we help you today?',
      welcomeDelayMs: 1000,
    };
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
      const num    = await nextContactNum(userId);
      const prefix = settings.autoSavePrefix || 'Customer';
      contact = await Contact.create({
        userId,
        phone,
        whatsappName:   pushName || null,
        generatedName:  `${prefix} ${num}`,
        displayName:    pushName || `${prefix} ${num}`,
        firstMessageAt: new Date(),
      });
    } else if (pushName && !contact.whatsappName) {
      contact.whatsappName = pushName;
      contact.displayName  = contact.name || pushName || contact.generatedName;
      await contact.save();
    }
    return contact;
  } catch (err) {
    console.error('[WA] autoSaveContact error:', err.message);
    return null;
  }
}

// ── matchAutoReply (standalone utility – kept for optional direct use) ────────
// BUG FIX 4: this function existed but the main handler was doing its own
// duplicate inline matching without the time-restriction check. Removed
// the duplicate; the handler now calls this single function.
async function matchAutoReply(userId, text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  try {
    const rules = await AutoReply.find({ userId, status: 'active' }).sort({ priority: -1 });
    for (const rule of rules) {
      // ── Time restriction ──────────────────────────────────────────────────
      if (rule.timeRestriction !== 'always') {
        const now = new Date();
        const [sh, sm] = (rule.businessHoursStart || '09:00').split(':').map(Number);
        const [eh, em] = (rule.businessHoursEnd   || '18:00').split(':').map(Number);
        const cur   = now.getHours() * 60 + now.getMinutes();
        const inBiz = cur >= sh * 60 + sm && cur <= eh * 60 + em;
        if (rule.timeRestriction === 'business_hours' && !inBiz) continue;
        if (rule.timeRestriction === 'off_hours'      && inBiz)  continue;
      }

      // ── Keyword match ─────────────────────────────────────────────────────
      const matched = rule.keywords.some((kw) => {
        const k = kw.toLowerCase().trim();
        switch (rule.matchType) {
          case 'exact':       return lower === k;
          case 'starts_with': return lower.startsWith(k);
          default:            return lower.includes(k);  // 'contains'
        }
      });

      if (matched) return rule;
    }
  } catch (err) {
    console.error('[WA] matchAutoReply error:', err.message);
  }
  return null;
}

// ── Referral / contest detection ──────────────────────────────────────────────
// BUG FIX 5: was using ReferralParticipant which doesn't exist; replaced with
// ContestParticipant which is the real model.
async function detectReferral(userId, phone, text) {
  if (!text) return;
  const match = text.match(/REF[A-Z0-9]{3,10}/i);
  if (!match) return;
  const code = match[0].toUpperCase();
  try {
    const contest = await Contest.findOne({ userId, status: 'active' });
    if (!contest) return;

    const exists = await ContestParticipant.findOne({ contestId: contest._id, phone });
    if (exists) return;

    const referrer = await ContestParticipant.findOne({ contestId: contest._id, referralCode: code });
    await ContestParticipant.create({
      contestId:    contest._id,
      userId,
      phone,
      name:         phone,
      referralCode: `REF${Date.now().toString(36).toUpperCase()}`,
      referredBy:   code,
      referrerId:   referrer?._id || null,
    });
    if (referrer) {
      await ContestParticipant.findByIdAndUpdate(referrer._id, {
        $inc: { activeReferrals: 1, lifetimeReferrals: 1 },
        lastReferralDate: new Date(),
      });
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
    if (!msg)          return;
    if (!msg.message)  return;
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;

    // BUG FIX 6: was skipping group messages entirely. Group JIDs end in
    // @g.us – allow them through but skip broadcast lists.
    if (!jid) return;
    if (isJidBroadcast(jid)) return;          // skip broadcast lists
    const isGroup = isJidGroup(jid);

    // BUG FIX 7: use the shared messageText() helper so button/list replies
    // are also captured, instead of the old inline repetition.
    const text = messageText(msg).trim();

    if (!text) return;

    console.log(`[WA] 📨 Incoming ${isGroup ? 'group' : 'DM'} message: ${text}`);

    // For group messages the sender is in msg.key.participant
    const senderJid = isGroup ? msg.key.participant : jid;
    if (!senderJid) return;

    const phone = jidToPhone(senderJid);

    // ── Auto-save / lookup contact ────────────────────────────────────────
    let contact = await Contact.findOne({ userId, phone });
    if (!contact) {
      console.log('[WA] New contact, saving...');
      contact = await Contact.create({
        userId,
        phone,
        displayName:    msg.pushName || phone,
        isActive:       true,
        firstMessageAt: new Date(),
      });

      // Welcome message only for DMs, not group chats
      if (!isGroup) {
        const settings = await getUserSettings(userId);
        if (settings.sendWelcome !== false) {
          const welcomeText = settings.welcomeMessage || 'Welcome! Thanks for contacting us.';
          const delay       = settings.welcomeDelayMs ?? 1000;
          await new Promise(resolve => setTimeout(resolve, delay));

          // BUG FIX 8: welcome reply must go to the DM JID (senderJid for DMs)
          await sock.sendMessage(jid, { text: welcomeText });
          console.log('[WA] Welcome message sent');

          await Message.create({
            userId,
            contactId: contact._id,
            phone,
            direction: 'outbound',
            body:      welcomeText,
            status:    'sent',
            timestamp: new Date(),
          });
        }
      }
      // Don't attempt auto-reply for brand new contacts that just got a welcome
      return;
    }

    // ── Update contact stats ──────────────────────────────────────────────
    await Contact.findByIdAndUpdate(contact._id, {
      $inc:          { totalMessages: 1 },
      lastMessageAt: new Date(),
      // BUG FIX 9: update whatsappName if we now have a pushName
      ...(msg.pushName && !contact.whatsappName ? { whatsappName: msg.pushName } : {}),
    });

    // ── Log inbound message ───────────────────────────────────────────────
    await Message.create({
      userId,
      contactId:        contact._id,
      phone,
      direction:        'inbound',
      body:             text,
      type:             Object.keys(msg.message)[0]?.replace('Message', '') || 'text',
      whatsappMessageId: msg.key.id,
      timestamp:        new Date(),
      status:           'received',
    });

    // ── Emit real-time event ──────────────────────────────────────────────
    io.to(`user-${userId}`).emit('whatsapp:message', {
      contact: { id: contact._id, name: contact.displayName, phone },
      message: { text, timestamp: Date.now(), isGroup },
    });

    // ── Referral / contest detection ──────────────────────────────────────
    await detectReferral(userId, phone, text);

    // ── Contest command handler ───────────────────────────────────────────
    try {
      await handleContestCommand(sock, userId, jid, senderJid, text, msg.pushName);
    } catch (e) {
      console.error('[WA] handleContestCommand error:', e.message);
    }

    // ── Auto-reply ────────────────────────────────────────────────────────
    // Skip auto-reply in group chats (configurable in future)
    if (isGroup) return;

    // BUG FIX 10: Cooldown via in-memory map instead of a DB query.
    // The old DB query used `autoReplyId: { $ne: null }` and `createdAt`
    // but Message.createdAt is set by Mongoose timestamps, whereas the code
    // was writing `timestamp` – they are different fields, so the cooldown
    // query never matched and spam protection was silently broken.
    const cooldownKey = `${userId}:${phone}`;
    const COOLDOWN_MS = 15_000;
    const lastSent    = autoReplyCooldowns.get(cooldownKey);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
      console.log('[WA] Skipping auto-reply – cooldown active');
      return;
    }

    // BUG FIX 11: was duplicating the match logic inline AND calling
    // matchAutoReply separately. Now uses only matchAutoReply which also
    // properly applies time restrictions.
    const matchedRule = await matchAutoReply(userId, text);

    if (!matchedRule) {
      console.log('[WA] ❌ No rule matched for:', text);
      return;
    }

    console.log(`[WA] ✅ MATCHED rule: "${matchedRule.name}"`);

    // ── Send auto-reply ───────────────────────────────────────────────────
    const delay = matchedRule.delayMs ?? 1000;
    console.log(`[WA] Sending auto-reply after ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));

    await sock.sendMessage(jid, { text: matchedRule.reply });
    console.log('[WA] ✅ Auto-reply sent successfully');

    // Update cooldown
    autoReplyCooldowns.set(cooldownKey, Date.now());
    // Clean up old cooldown entries periodically (memory hygiene)
    setTimeout(() => autoReplyCooldowns.delete(cooldownKey), COOLDOWN_MS + 1000);

    // ── Persist outbound message & update rule stats ──────────────────────
    await Message.create({
      userId,
      contactId:   contact._id,
      phone,
      direction:   'outbound',
      body:        matchedRule.reply,
      autoReplyId: matchedRule._id,
      status:      'sent',
      timestamp:   new Date(),
    });

    // BUG FIX 12: was calling rule.save() which could race-condition the
    // triggerCount; use atomic $inc instead.
    await AutoReply.findByIdAndUpdate(matchedRule._id, { $inc: { triggerCount: 1 } });

  } catch (err) {
    console.error('[WA] Message processing error:', err);
  }
}

// ── PAIRING CODE METHOD ───────────────────────────────────────────────────────
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
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth:                  state,
      browser:               ['WAFlow', 'Chrome', '120.0.0.0'],
      connectTimeoutMs:      60_000,
      keepAliveIntervalMs:   15_000,
      retryRequestDelayMs:   2_000,
      maxMsgRetryCount:      3,
      getMessage: async () => ({ conversation: '' }),
    });

    sessions.set(userId, sock);

    sock.ev.on('connection.update', async ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        console.log('[WA] QR code generated as backup');
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
        io.to(`user-${userId}`).emit('whatsapp:qr', { qr: qrDataUrl });
      }

      if (connection === 'open') {
        const phone    = sock.user?.id ? jidToPhone(sock.user.id) : null;
        const pushName = sock.user?.name || null;

        await User.findByIdAndUpdate(userId, {
          whatsappConnected:   true,
          whatsappPhone:       phone,
          whatsappName:        pushName,
          whatsappPushName:    pushName,
          whatsappSessionPath: sPath,
        });

        io.to(`user-${userId}`).emit('whatsapp:connected', { phone, name: pushName });
        console.log(`[WA] User ${userId} connected via pairing – ${pushName || phone}`);
      }

      if (connection === 'close') {
        sessions.delete(userId);
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          console.log(`[WA] Pairing session disconnected, code: ${code}`);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Shared message handler ────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages }) => {
      // BUG FIX 13: iterate all messages in the batch, not just [0].
      // WhatsApp sometimes delivers multiple messages in a single upsert.
      for (const m of messages) {
        await handleIncomingMessage(sock, userId, io, m);
      }
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
        io.to(`user-${userId}`).emit('whatsapp:error', { message: 'Failed to generate pairing code. Try again.' });
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

  const sock  = sessions.get(userId);
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
    whatsappConnected:   false,
    whatsappPhone:       null,
    whatsappName:        null,
    whatsappPushName:    null,
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

// ── Get group members ─────────────────────────────────────────────────────────
async function getAllGroupMembers(userId, groupId) {
  const sock = sessions.get(userId);
  if (!sock) throw new Error('WhatsApp not connected');

  try {
    const groupMetadata = await sock.groupMetadata(groupId);
    return groupMetadata.participants.map(p => ({
      id:           p.id,
      name:         p.name || null,
      phone:        p.id.split('@')[0],
      isAdmin:      p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    }));
  } catch (err) {
    console.error('[Group Extract] Error:', err);
    throw err;
  }
}

// ── QR CODE METHOD ────────────────────────────────────────────────────────────
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
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth:                  state,
      browser:               ['WAFlow', 'Chrome', '120.0.0.0'],
      connectTimeoutMs:      60_000,
      keepAliveIntervalMs:   15_000,
      retryRequestDelayMs:   2_000,
      maxMsgRetryCount:      3,
      getMessage: async () => ({ conversation: '' }),
    });

    sessions.set(userId, sock);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 256 });
        io.to(`user-${userId}`).emit('whatsapp:qr', { qr: qrDataUrl });
      }

      if (connection === 'open') {
        const phone    = sock.user?.id ? jidToPhone(sock.user.id) : null;
        const pushName = sock.user?.name || null;

        await User.findByIdAndUpdate(userId, {
          whatsappConnected:   true,
          whatsappPhone:       phone,
          whatsappName:        pushName,
          whatsappPushName:    pushName,
          whatsappSessionPath: sPath,
        });
        io.to(`user-${userId}`).emit('whatsapp:connected', { phone, name: pushName });
        console.log(`[WA] User ${userId} connected via QR – ${pushName || phone}`);
      }

      if (connection === 'close') {
        sessions.delete(userId);
        const code      = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;

        if (loggedOut) {
          await User.findByIdAndUpdate(userId, { whatsappConnected: false, whatsappPhone: null });
          io.to(`user-${userId}`).emit('whatsapp:disconnected', { reason: 'logged_out' });
          try { fs.rmSync(sPath, { recursive: true }); } catch (_) {}
          console.log(`[WA] User ${userId} logged out`);
        } else {
          io.to(`user-${userId}`).emit('whatsapp:reconnecting', {});
          console.log(`[WA] User ${userId} disconnected – reconnecting in 5s`);
          const timer = setTimeout(() => createSession(userId, io), 5000);
          reconnectTimers.set(userId, timer);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Shared message handler ────────────────────────────────────────────
    // BUG FIX 13 (same as above): iterate all messages in the upsert batch.
    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        await handleIncomingMessage(sock, userId, io, m);
      }
    });

    return sock;
  } catch (err) {
    console.error(`[WA] createSession error for user ${userId}:`, err.message);
    const timer = setTimeout(() => createSession(userId, io), 8000);
    reconnectTimers.set(userId, timer);
  }
}

module.exports = {
  createSession,
  createSessionWithPairing,
  disconnectSession,
  sendMessage,
  initWhatsApp,
  sessions,
  getAllGroupMembers,
};
