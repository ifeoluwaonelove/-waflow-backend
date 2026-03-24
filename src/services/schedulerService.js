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

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try {
      const due = await Broadcast.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } });
      for (const b of due) executeBroadcast(b).catch(console.error);
    } catch (err) {
      console.error('[Scheduler] Cron error:', err.message);
    }
  });
  console.log('[Scheduler] Started');
}

module.exports = { startScheduler, executeBroadcast };
