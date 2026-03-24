'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { createSession, disconnectSession, sendMessage, sessions } = require('../whatsapp/engine');
const { Message, Contact } = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

router.post('/connect', protect, async (req, res, next) => {
  try {
    const io = req.app.get('io');
    await createSession(req.user._id.toString(), io, true);
    res.json(formatResponse(true, 'Session initialised — scan the QR code'));
  } catch (err) { next(err); }
});

router.post('/disconnect', protect, async (req, res, next) => {
  try {
    await disconnectSession(req.user._id.toString());
    res.json(formatResponse(true, 'WhatsApp disconnected'));
  } catch (err) { next(err); }
});

router.get('/status', protect, (req, res) => {
  res.json(formatResponse(true, 'OK', {
    connected: sessions.has(req.user._id.toString()),
    phone: req.user.whatsappPhone || null,
  }));
});

router.post('/send-message', protect, async (req, res, next) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json(formatResponse(false, 'phone and message required'));
    await sendMessage(req.user._id.toString(), phone, message);
    const contact = await Contact.findOne({ userId: req.user._id, phone });
    await Message.create({ userId: req.user._id, contactId: contact?._id, phone, direction: 'outbound', body: message, status: 'sent' });
    res.json(formatResponse(true, 'Message sent'));
  } catch (err) { next(err); }
});

router.get('/messages/:phone', protect, async (req, res, next) => {
  try {
    const messages = await Message.find({ userId: req.user._id, phone: req.params.phone }).sort({ timestamp: -1 }).limit(50);
    res.json(formatResponse(true, 'OK', { messages }));
  } catch (err) { next(err); }
});

router.get('/deleted-messages', protect, async (req, res, next) => {
  try {
    const messages = await Message.find({ userId: req.user._id, isDeleted: true })
      .populate('contactId', 'displayName phone').sort({ timestamp: -1 }).limit(100);
    res.json(formatResponse(true, 'OK', { messages }));
  } catch (err) { next(err); }
});

module.exports = router;
