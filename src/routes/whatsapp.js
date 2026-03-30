'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { createSession, disconnectSession, sendMessage, sessions } = require('../whatsapp/engine');
const { Message, Contact, User } = require('../models');
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

router.get('/status', protect, async (req, res) => {
  try {
    // Fetch fresh user data to get the latest push name
    const user = await User.findById(req.user._id).select('whatsappConnected whatsappPhone whatsappName whatsappPushName');
    
    // Determine what to display
    const displayName = user.whatsappPushName || user.whatsappName || user.whatsappPhone;
    const isConnected = sessions.has(req.user._id.toString()) && user.whatsappConnected;
    
    res.json(formatResponse(true, 'OK', {
      connected: isConnected,
      phone: user.whatsappPhone || null,
      pushName: user.whatsappPushName || null,
      displayName: displayName || null,
      message: isConnected && displayName ? `${displayName} (Connected)` : isConnected ? 'Connected' : 'Not connected'
    }));
  } catch (err) {
    console.error('[WhatsApp Status] Error:', err);
    res.json(formatResponse(true, 'OK', {
      connected: sessions.has(req.user._id.toString()),
      phone: req.user.whatsappPhone || null,
      pushName: null,
      displayName: null,
      message: sessions.has(req.user._id.toString()) ? 'Connected' : 'Not connected'
    }));
  }
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
/**
 * POST /api/whatsapp/reset
 * Force reset WhatsApp connection
 */
router.post('/reset', protect, async (req, res, next) => {
  try {
    const userId = req.user._id.toString();
    const fs = require('fs');
    const path = require('path');
    const sessionsDir = path.join(__dirname, '../../sessions');
    const userSessionPath = path.join(sessionsDir, `user_${userId}`);
    
    if (fs.existsSync(userSessionPath)) {
      fs.rmSync(userSessionPath, { recursive: true, force: true });
    }
    
    const { disconnectSession } = require('../whatsapp/engine');
    await disconnectSession(userId);
    
    res.json(formatResponse(true, 'WhatsApp reset complete. Please try connecting again.'));
  } catch (err) {
    console.error('[WhatsApp] Reset error:', err);
    next(err);
  }
});

module.exports = router;