'use strict';
/**
 * Scheduler Service — lean version for Render free tier
 * Handles: scheduled broadcasts (batched) + text reminder/follow-up schedules
 * Removed: status/channel/group media scheduling (reduces memory footprint)
 */
const cron = require('node-cron');
const { Broadcast, Message, Contact, Schedule } = require('../models');
const { sessions, sendMessage } = require('../whatsapp/engine');
const { startCleanupScheduler } = require('./cleanupService');

function startScheduler() {
  // ... existing scheduler code ...
  
  // Start cleanup scheduler
  startCleanupScheduler();
  
  console.log('[Scheduler] All jobs started');
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────
function personalize(text, contact) {
  return (text || '')
    .replace(/\{name\}/gi, contact.displayName || 'Friend')
    .replace(/\{phone\}/gi, contact.phone || '');
}

function pickMessage(broadcast, index) {
  const msgs = broadcast.messages;
  if (!msgs?.length) return { text: '' };
  if (broadcast.rotationMode === 'random') return msgs[Math.floor(Math.random() * msgs.length)];
  if (broadcast.rotationMode === 'sequential') return msgs[index % msgs.length];
  return msgs[0];
}

// ── Execute broadcast — batched 10 at a time for Render memory ────────────────
async function executeBroadcast(broadcast) {
  broadcast.status = 'sending';
  await broadcast.save();

  try {
    const uid = broadcast.userId.toString();
    if (!sessions.has(uid)) throw new Error('WhatsApp not connected');

    const query = { userId: broadcast.userId, isActive: true, isBlocked: false };
    if (broadcast.targetType === 'group'  && broadcast.targetGroup)        query.group = broadcast.targetGroup;
    else if (broadcast.targetType === 'tags' && broadcast.targetTags?.length) query.tags = { $in: broadcast.targetTags };
    else if (broadcast.targetType === 'custom' && broadcast.targetContacts?.length) query._id = { $in: broadcast.targetContacts };

    const contacts = await Contact.find(query).lean();
    broadcast.totalRecipients = contacts.length;
    await broadcast.save();

    let delivered = 0, failed = 0;
    const BATCH = 10;
    const DELAY = broadcast.delayBetweenMessages || 2000;

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const tpl  = pickMessage(broadcast, i);
      const text = personalize(tpl.text, contact);
      try {
        await sendMessage(uid, contact.phone, text);
        // Lean message log — no body stored to save MongoDB space
        await Message.create({
          userId: broadcast.userId, contactId: contact._id, phone: contact.phone,
          direction: 'outbound', status: 'sent', broadcastId: broadcast._id,
          timestamp: new Date(),
        });
        delivered++;
      } catch (e) {
        failed++;
        console.error(`[Scheduler] Broadcast send failed to ${contact.phone}:`, e.message);
      }
      // Pause after each batch for Render memory recovery
      if ((i + 1) % BATCH === 0) await new Promise(r => setTimeout(r, 1000));
      else if (i < contacts.length - 1) await new Promise(r => setTimeout(r, DELAY));
    }

    // Prune message bodies to free MongoDB storage
    broadcast.messages = [];
    broadcast.status   = 'sent';
    broadcast.sentAt   = new Date();
    broadcast.delivered = delivered;
    broadcast.failed    = failed;
    await broadcast.save();
    console.log(`[Scheduler] Broadcast "${broadcast.title}" — ${delivered}/${contacts.length} delivered`);
  } catch (err) {
    broadcast.status = 'failed';
    await broadcast.save();
    console.error('[Scheduler] Broadcast failed:', err.message);
  }
}

// ── Execute a text reminder / follow-up schedule ──────────────────────────────
async function executeSchedule(schedule) {
  try {
    const sock = sessions.get(schedule.userId.toString());
    if (!sock) throw new Error('WhatsApp not connected');

    if (!schedule.content) throw new Error('No content');

    // Send to each target contact
    const targets = schedule.targetContacts || [];
    if (targets.length === 0) {
      // No targets — log as reminder-only (no WhatsApp send)
      schedule.status = 'sent';
      schedule.sentAt = new Date();
      await schedule.save();
      console.log(`[Scheduler] Reminder ${schedule._id} logged (no contacts)`);
      return;
    }

    for (const cId of targets) {
      try {
        const contact = await Contact.findById(cId).lean();
        if (!contact) continue;
        const jid  = contact.phone.replace('+', '').replace(/\D/g, '') + '@s.whatsapp.net';
        const text = personalize(schedule.content, contact);
        await sock.sendMessage(jid, { text });
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.error(`[Scheduler] Reminder contact send error:`, e.message);
      }
    }

    schedule.status = 'sent';
    schedule.sentAt = new Date();
    await schedule.save();
    console.log(`[Scheduler] Schedule ${schedule._id} (${schedule.type}) sent`);
  } catch (err) {
    schedule.retryCount = (schedule.retryCount || 0) + 1;
    if (schedule.retryCount >= 3) {
      schedule.status       = 'failed';
      schedule.errorMessage = err.message;
    }
    await schedule.save();
    console.error(`[Scheduler] Schedule ${schedule._id} failed:`, err.message);
  }
}

// ── Cron: runs every minute ───────────────────────────────────────────────────
function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();

      // Broadcasts
      const dueBroadcasts = await Broadcast.find({ status: 'scheduled', scheduledAt: { $lte: now } }).lean();
      for (const b of dueBroadcasts) {
        const full = await Broadcast.findById(b._id);
        if (full) executeBroadcast(full).catch(console.error);
      }

      // Text schedules (reminder / follow_up / contact)
      const dueSchedules = await Schedule.find({
        status: 'pending',
        scheduledAt: { $lte: now },
        retryCount: { $lt: 3 },
      });
      for (const s of dueSchedules) executeSchedule(s).catch(console.error);

    } catch (err) {
      console.error('[Scheduler] Cron error:', err.message);
    }
  });
  console.log('[Scheduler] Started');
}

module.exports = { startScheduler, executeBroadcast, executeSchedule };
