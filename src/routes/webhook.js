'use strict';
const express = require('express');
const { User, Contact, Message, Broadcast } = require('../models');
const { sendMessage } = require('../whatsapp/engine');
const { executeBroadcast } = require('../services/schedulerService');
const { formatResponse } = require('../utils/response');
const router = express.Router();

const apiKeyAuth = async (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json(formatResponse(false, 'X-API-Key header required'));
  const user = await User.findOne({ apiKey: key, isActive: true });
  if (!user) return res.status(401).json(formatResponse(false, 'Invalid API key'));
  req.user = user;
  next();
};

// POST /api/webhook/send-message
router.post('/send-message', apiKeyAuth, async (req, res, next) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json(formatResponse(false, 'phone and message required'));
    await sendMessage(req.user._id.toString(), phone, message);
    const contact = await Contact.findOne({ userId: req.user._id, phone });
    await Message.create({ userId: req.user._id, contactId: contact?._id, phone, direction: 'outbound', body: message, status: 'sent' });
    res.json(formatResponse(true, 'Message sent'));
  } catch (err) { next(err); }
});

// POST /api/webhook/broadcast
router.post('/broadcast', apiKeyAuth, async (req, res, next) => {
  try {
    const { message, group, tags } = req.body;
    if (!message) return res.status(400).json(formatResponse(false, 'message required'));
    const broadcast = await Broadcast.create({
      userId: req.user._id,
      title: `Webhook Broadcast ${new Date().toISOString()}`,
      messages: [{ text: message }],
      targetType: group ? 'group' : tags ? 'tags' : 'all',
      targetGroup: group, targetTags: tags,
      status: 'scheduled', scheduledAt: new Date(),
    });
    executeBroadcast(broadcast).catch(console.error);
    res.json(formatResponse(true, 'Broadcast queued', { broadcastId: broadcast._id }));
  } catch (err) { next(err); }
});

// GET /api/webhook/contacts
router.get('/contacts', apiKeyAuth, async (req, res, next) => {
  try {
    const { group, limit = 100, page = 1 } = req.query;
    const query = { userId: req.user._id, isActive: true };
    if (group) query.group = group;
    const contacts = await Contact.find(query).select('phone displayName group tags createdAt')
      .skip((page - 1) * limit).limit(parseInt(limit));
    res.json(formatResponse(true, 'OK', { contacts }));
  } catch (err) { next(err); }
});

module.exports = router;
