'use strict';
const cron = require('node-cron');
const { Broadcast, Message, Contact } = require('../models');
const { sessions, sendMessage } = require('../whatsapp/engine');

function personalize(text, contact) {
  return text
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

async function executeBroadcast(broadcast) {
  broadcast.status = 'sending';
  await broadcast.save();

  try {
    if (!sessions.has(broadcast.userId.toString())) throw new Error('WhatsApp not connected');

    const query = { userId: broadcast.userId, isActive: true, isBlocked: false };
    if (broadcast.targetType === 'group' && broadcast.targetGroup) query.group = broadcast.targetGroup;
    else if (broadcast.targetType === 'tags' && broadcast.targetTags?.length) query.tags = { $in: broadcast.targetTags };
    else if (broadcast.targetType === 'custom' && broadcast.targetContacts?.length) query._id = { $in: broadcast.targetContacts };

    const contacts = await Contact.find(query);
    broadcast.totalRecipients = contacts.length;
    await broadcast.save();

    let delivered = 0, failed = 0;

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      const tpl = pickMessage(broadcast, i);
      const text = personalize(tpl.text, contact);
      try {
        await sendMessage(broadcast.userId.toString(), contact.phone, text);
        await Message.create({ userId: broadcast.userId, contactId: contact._id, phone: contact.phone, direction: 'outbound', body: text, broadcastId: broadcast._id, status: 'sent' });
        delivered++;
      } catch (e) {
        failed++;
        console.error(`[Scheduler] Failed to send to ${contact.phone}:`, e.message);
      }
      if (i < contacts.length - 1) {
        await new Promise((r) => setTimeout(r, broadcast.delayBetweenMessages || 2000));
      }
    }

    broadcast.status = 'sent';
    broadcast.sentAt = new Date();
    broadcast.delivered = delivered;
    broadcast.failed = failed;
    await broadcast.save();
    console.log(`[Scheduler] Broadcast "${broadcast.title}" — ${delivered}/${contacts.length} delivered`);
  } catch (err) {
    broadcast.status = 'failed';
    await broadcast.save();
    console.error('[Scheduler] Broadcast failed:', err.message);
  }
}

// ── Execute a Schedule item (status/channel/group/contact) ────────────────────
async function executeSchedule(schedule) {
  const { Schedule } = require('../models');
  try {
    const sock = sessions.get(schedule.userId.toString());
    if (!sock) throw new Error('WhatsApp not connected');

    const msgPayload = schedule.mediaUrl
      ? { [schedule.mediaType || 'image']: { url: schedule.mediaUrl }, caption: schedule.content || '' }
      : { text: schedule.content };

    switch (schedule.type) {
      case 'status': {
        // Send to WA status (broadcast list)
        await sock.sendMessage('status@broadcast', msgPayload);
        break;
      }
      case 'channel':
      case 'group': {
        const targets = schedule.type === 'channel' ? schedule.targetChannels : schedule.targetGroups;
        for (const t of targets || []) {
          try {
            await sock.sendMessage(t.jid, msgPayload);
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) {
            console.error(`[Scheduler] Failed to send to ${t.jid}:`, e.message);
          }
        }
        break;
      }
      case 'contact': {
        const { Contact } = require('../models');
        for (const cId of schedule.targetContacts || []) {
          try {
            const contact = await Contact.findById(cId);
            if (!contact) continue;
            const jid = contact.phone.replace('+', '') + '@s.whatsapp.net';
            await sock.sendMessage(jid, msgPayload);
            await new Promise(r => setTimeout(r, 1500));
          } catch (e) {
            console.error(`[Scheduler] Contact send error:`, e.message);
          }
        }
        break;
      }
    }

    schedule.status = 'sent';
    schedule.sentAt = new Date();
    await schedule.save();
    console.log(`[Scheduler] Schedule ${schedule._id} (${schedule.type}) executed`);
  } catch (err) {
    schedule.retryCount = (schedule.retryCount || 0) + 1;
    if (schedule.retryCount >= 3) {
      schedule.status = 'failed';
      schedule.errorMessage = err.message;
    }
    await schedule.save();
    console.error(`[Scheduler] Schedule ${schedule._id} failed:`, err.message);
  }
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();

      // Broadcasts
      const dueBroadcasts = await Broadcast.find({ status: 'scheduled', scheduledAt: { $lte: now } });
      for (const b of dueBroadcasts) executeBroadcast(b).catch(console.error);

      // Schedules (status/channel/group/contact)
      const { Schedule } = require('../models');
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
  console.log('[Scheduler] Started (broadcasts + schedules)');
}

module.exports = { startScheduler, executeBroadcast, executeSchedule };
