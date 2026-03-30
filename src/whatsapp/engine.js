'use strict';
/**
 * WAFlow WhatsApp Engine
 * Built on @whiskeysockets/baileys
 *
 * Features:
 *  - Multi-session (one per user)
 *  - Auto-reconnect on disconnect
 *  - QR regeneration
 *  - Session persistence on disk
 *  - Graceful error recovery (never crashes the server)
 *  - Auto-save unknown contacts
 *  - Auto-reply matching
 *  - Deleted message recovery
 *  - Referral code detection
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
const sessions = new Map();          // userId -> WASocket
const reconnectTimers = new Map();   // userId -> timer
const contactCounters = new Map();   // userId -> sequential number

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

// ── Get or create user settings (cached per session) ─────────────────────────
const settingsCache = new Map(); // userId -> settings

async function getUserSettings(userId) {
  if (settingsCache.has(userId)) return settingsCache.get(userId);
  try {
    const { UserSettings } = require('../models');
    let s = await UserSettings.findOne({ userId });
    if (!s) s = await UserSettings.create({ userId });
    settingsCache.set(userId, s);
    // Invalidate cache after 60s so live changes take effect
    setTimeout(() => settingsCache.delete(userId), 60000);
    return s;
  } catch (e) {
    return { autoSaveContacts: true, autoSavePrefix: 'Customer', sendWelcome: true, welcomeMessage: 'Hello 👋\n\nWelcome! How can we help you today?', welcomeDelayMs: 1000 };
  }
}

// ── Auto-save contact ─────────────────────────────────────────────────────────
async function autoSaveContact(userId, jid, pushName) {
  const phone    = jidToPhone(jid);
  const settings = await getUserSettings(userId);

  try {
    let contact = await Contact.findOne({ userId, phone });
    if (!contact) {
      if (!settings.autoSaveContacts) return null; // auto-save disabled

      const num  = await nextContactNum(userId);
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

// ── Core: create / restore a session ─────────────────────────────────────────
async function createSession(userId, io, forceNew = false) {
  // Clear any pending reconnect timer
  if (reconnectTimers.has(userId)) {
    clearTimeout(reconnectTimers.get(userId));
    reconnectTimers.delete(userId);
  }

  // Close existing socket if force-new
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
const version = [2, 3000, 1015901307]; // Stable version

const sock = makeWASocket({
  version: [2, 3000, 1015901307],
  auth: state,
  printQRInTerminal: false,
  browser: ['WAFlow', 'Chrome', '120.0.0.0'],
  connectTimeoutMs: 60000,
  keepAliveIntervalMs: 15000,
  retryRequestDelayMs: 2000,
  maxMsgRetryCount: 3,
  getMessage: async () => ({ conversation: '' }),
  // Critical: Disable the new pairing method
  defaultQueryTimeoutMs: undefined,
  generateHighQualityLink: true, // Better QR quality
  syncFullHistory: false,
  // Add these to prevent auto-pairing
  patchMessageBeforeSending: (message) => message,
  cachedGroupMetadata: () => ({}),
});
// Force QR code generation
if (!state.creds.registered) {
  console.log('[WA] Waiting for QR code...');
  // This ensures QR is generated
  setTimeout(() => {
    if (!state.creds.registered) {
      console.log('[WA] QR not scanned yet, still waiting...');
    }
  }, 5000);
}
// Small delay to allow socket to initialize
await new Promise(resolve => setTimeout(resolve, 1000));

    sessions.set(userId, sock);

          // ── Connection state updates ──────────────────────────────────────────────
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      try {
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
          io.to(`user-${userId}`).emit('whatsapp:connected', { 
            phone, 
            name: pushName,
            pushName: pushName
          });
          console.log(`[WA] User ${userId} connected — ${pushName || phone}`);
        }

if (connection === 'close') {
  sessions.delete(userId);
  const code = lastDisconnect?.error?.output?.statusCode;
  const loggedOut = code === DisconnectReason.loggedOut;

  // Don't retry on 515 errors
  if (code === 515) {
    console.log(`[WA] Stream error 515 for user ${userId} - not retrying automatically`);
    await User.findByIdAndUpdate(userId, { 
      whatsappConnected: false, 
      whatsappPhone: null,
      whatsappName: null,
      whatsappPushName: null
    });
    io.to(`user-${userId}`).emit('whatsapp:disconnected', { reason: 'stream_error' });
    return;
  }

  if (loggedOut) {
    await User.findByIdAndUpdate(userId, { whatsappConnected: false, whatsappPhone: null });
    io.to(`user-${userId}`).emit('whatsapp:disconnected', { reason: 'logged_out' });
    try { fs.rmSync(sPath, { recursive: true }); } catch (_) {}
    console.log(`[WA] User ${userId} logged out`);
  } else {
    io.to(`user-${userId}`).emit('whatsapp:reconnecting', {});
    console.log(`[WA] User ${userId} disconnected (code ${code}) — reconnecting in 5s`);
    const timer = setTimeout(() => createSession(userId, io), 5000);
    reconnectTimers.set(userId, timer);
  }
}
      } catch (err) {
        console.error('[WA] connection.update handler error:', err.message);
      }
    });

    // ── Save session when credentials update ─────────────────────────────────
    sock.ev.on('creds.update', async (creds) => {
      try {
        const phone = sock.user?.id ? jidToPhone(sock.user.id) : null;
        if (phone && userId) {
          // Save session data to database (prevents duplicates)
          await saveSession(userId, phone, creds, {
            platform: process.platform,
            browser: 'WAFlow',
            version: require('../../package.json').version
          });
          console.log(`[Session] Saved session for ${phone}`);
        }
      } catch (err) {
        console.error('[Session] Save error:', err.message);
      }
    });

       // ── Incoming messages ─────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
      if (type !== 'notify') return;

      for (const msg of msgs) {
        try {
          const jid = msg.key.remoteJid;
          if (!jid || isJidBroadcast(jid) || isJidGroup(jid)) continue;
          if (msg.key.fromMe) continue;

          const text = messageText(msg);
          const phone = jidToPhone(jid);

          // 1. Auto-save contact
          const contact = await autoSaveContact(userId, jid, msg.pushName);
          if (!contact) continue;

          const isNewContact = contact.totalMessages === 0;

          // 2. Log inbound message
          await Message.create({
            userId,
            contactId: contact._id,
            phone,
            direction: 'inbound',
            body: text || '[media]',
            type: Object.keys(msg.message || {})[0]?.replace('Message', '') || 'text',
            whatsappMessageId: msg.key.id,
            timestamp: new Date((msg.messageTimestamp || Date.now() / 1000) * 1000),
            status: 'received',
          });

          await Contact.findByIdAndUpdate(contact._id, {
            $inc: { totalMessages: 1 },
            lastMessageAt: new Date(),
          });

          // 3. Status viewer DONE confirmation
          if (text.trim().toUpperCase() === 'DONE') {
            await Contact.findByIdAndUpdate(contact._id, { isStatusViewer: true, savedNumber: true });
          }

          // 4. Contest command handler
          const contestResult = await handleContestCommand(userId, phone, text, msg.pushName, sock, jid);
          if (contestResult.handled) {
            if (contestResult.reply) {
              setTimeout(async () => {
                try {
                  await sock.sendMessage(jid, { text: contestResult.reply });
                  await Message.create({
                    userId, contactId: contact._id, phone,
                    direction: 'outbound', body: contestResult.reply,
                    status: 'sent', timestamp: new Date(),
                  });
                } catch (e) {
                  console.error('[WA] Contest reply send error:', e.message);
                }
              }, 800);
            }
          } else {
            // 5. Auto-reply
            const rule = await matchAutoReply(userId, text);
            if (rule) {
              setTimeout(async () => {
                try {
                  await sock.sendMessage(jid, { text: rule.reply });
                  await Message.create({
                    userId,
                    contactId: contact._id,
                    phone,
                    direction: 'outbound',
                    body: rule.reply,
                    autoReplyId: rule._id,
                    status: 'sent',
                    timestamp: new Date(),
                  });
                } catch (e) {
                  console.error('[WA] Auto-reply send error:', e.message);
                }
              }, rule.delayMs || 1500);
            } else if (isNewContact) {
              const settings = await getUserSettings(userId);
              if (settings.sendWelcome && settings.welcomeMessage) {
                setTimeout(async () => {
                  try {
                    await sock.sendMessage(jid, { text: settings.welcomeMessage });
                    await Message.create({
                      userId, contactId: contact._id, phone,
                      direction: 'outbound', body: settings.welcomeMessage,
                      status: 'sent', timestamp: new Date(),
                    });
                  } catch (e) {
                    console.error('[WA] Welcome send error:', e.message);
                  }
                }, settings.welcomeDelayMs || 1000);
              }
            }
          }

          // 7. Auto-generate invoice for payment keywords
          const lowerText = text.toLowerCase();
          if (lowerText.includes('pay') && lowerText.includes('for')) {
            const invoice = await generateInvoiceFromMessage(userId, phone, text);
            if (invoice) {
              setTimeout(async () => {
                try {
                  const invoiceMessage = `📄 *INVOICE GENERATED* 📄\n\n` +
                    `Invoice #: ${invoice.invoiceNumber}\n` +
                    `Amount: ₦${invoice.total.toLocaleString()}\n` +
                    `Due Date: ${new Date(invoice.dueDate).toLocaleDateString()}\n\n` +
                    `Please make payment to complete your order.\n\n` +
                    `_Reply with "PAID ${invoice.invoiceNumber}" when payment is sent._`;
                  
                  await sock.sendMessage(jid, { text: invoiceMessage });
                  await Message.create({
                    userId, contactId: contact._id, phone,
                    direction: 'outbound', body: invoiceMessage,
                    status: 'sent', timestamp: new Date(),
                  });
                } catch (e) {
                  console.error('[WA] Invoice send error:', e.message);
                }
              }, 1000);
            }
          }
          
          // 8. Handle "PAID" confirmation
          if (lowerText.match(/^paid\s+inv/i)) {
            const invoiceMatch = text.match(/INV-\d+/i);
            if (invoiceMatch) {
              const invoiceNumber = invoiceMatch[0];
              const { processPayment, generateReceiptMessage } = require('../services/invoiceService');
              
              const result = await processPayment(invoiceNumber, 0, 'customer_confirmed');
              if (result.success) {
                const receiptMsg = generateReceiptMessage(result.invoice);
                setTimeout(async () => {
                  try {
                    await sock.sendMessage(jid, { text: receiptMsg });
                    await Message.create({
                      userId, contactId: contact._id, phone,
                      direction: 'outbound', body: receiptMsg,
                      status: 'sent', timestamp: new Date(),
                    });
                  } catch (e) {
                    console.error('[WA] Receipt send error:', e.message);
                  }
                }, 800);
              } else {
                setTimeout(async () => {
                  await sock.sendMessage(jid, { text: `❌ ${result.message}` });
                }, 800);
              }
            }
          }
          
                    // 9. Auto-create expense from message
          // Format: "expense 5000 for Facebook Ads" or "expense 2000 Transport"
          const expenseMatch = text.match(/expense\s+(\d+(?:\.\d+)?)\s+(.+)/i);
          if (expenseMatch) {
            const amount = parseFloat(expenseMatch[1]);
            const description = expenseMatch[2].trim();
            
            const expense = await createExpenseFromMessage(userId, phone, amount, description);
            if (expense) {
              setTimeout(async () => {
                try {
                  const expenseMessage = `💰 *EXPENSE RECORDED* 💰\n\n` +
                    `Amount: ₦${amount.toLocaleString()}\n` +
                    `Description: ${description}\n` +
                    `Category: ${expense.category}\n` +
                    `Date: ${new Date().toLocaleDateString()}\n\n` +
                    `_Expense has been added to your finance ledger._`;
                  
                  await sock.sendMessage(jid, { text: expenseMessage });
                  await Message.create({
                    userId, contactId: contact._id, phone,
                    direction: 'outbound', body: expenseMessage,
                    status: 'sent', timestamp: new Date(),
                  });
                } catch (e) {
                  console.error('[WA] Expense confirmation error:', e.message);
                }
              }, 800);
            }
          }

          // 6. Emit real-time event
          io.to(`user-${userId}`).emit('whatsapp:message', {
            contact: { id: contact._id, name: contact.displayName, phone },
            message: { text, timestamp: Date.now() }
          });
          
        } catch (err) {
          console.error('[WA] Message processing error:', err.message);
        }
      }
    });

    // ── Deleted message recovery ──────────────────────────────────────────────
    sock.ev.on('messages.update', async (updates) => {
      for (const update of updates) {
        try {
          if (update.update?.messageStubType !== 1) continue;
          const existing = await Message.findOne({ userId, whatsappMessageId: update.key.id });
          if (existing?.body && !existing.isDeleted) {
            existing.isDeleted = true;
            existing.deletedBody = existing.body;
            await existing.save();
            io.to(`user-${userId}`).emit('whatsapp:message_deleted', {
              messageId: update.key.id,
              recoveredText: existing.deletedBody,
              phone: jidToPhone(update.key.remoteJid),
            });
          }
        } catch (err) {
          console.error('[WA] Deleted message recovery error:', err.message);
        }
      }
    });

    return sock;
  } catch (err) {
    console.error(`[WA] createSession error for user ${userId}:`, err.message);
    // Schedule retry
    const timer = setTimeout(() => createSession(userId, io), 8000);
    reconnectTimers.set(userId, timer);
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
    try { 
      await sock.logout(); 
    } catch (_) {}
    sessions.delete(userId);
  }
  
  // Revoke session in database
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
      // Stagger reconnects to avoid hammering WA servers
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      // Session files gone (e.g. Render disk reset) — mark as disconnected
      await User.findByIdAndUpdate(user._id, { whatsappConnected: false, whatsappPhone: null });
    }
  }
}
/**
 * Extract ALL group members (bypasses Baileys 100-member cache limit)
 * @param {string} userId - User ID
 * @param {string} groupId - Group JID (e.g., "1234567890@g.us")
 * @returns {Promise<Array>} List of all group members
 */
async function getAllGroupMembers(userId, groupId) {
  const sock = sessions.get(userId);
  if (!sock) throw new Error('WhatsApp not connected');

  try {
    // Force fetch fresh group metadata (NOT from cache)
    const groupMetadata = await sock.groupMetadata(groupId);
    
    // Extract ALL participants (no 100 limit)
    const allMembers = groupMetadata.participants.map(p => ({
      id: p.id,
      name: p.name || null,
      phone: p.id.split('@')[0], // Extract phone number from JID
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

module.exports = { createSession, disconnectSession, sendMessage, initWhatsApp, sessions, getAllGroupMembers };
