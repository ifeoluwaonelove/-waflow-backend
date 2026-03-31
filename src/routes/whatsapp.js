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
router.post('/force-reset', protect, async (req, res, next) => {
  try {
    const userId = req.user._id.toString();
    const fs = require('fs');
    const path = require('path');
    const sessionsDir = path.join(__dirname, '../../sessions');
    
    // Delete ALL sessions (not just user's)
    if (fs.existsSync(sessionsDir)) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
    }
    fs.mkdirSync(sessionsDir, { recursive: true });
    
    // Also disconnect
    const { disconnectSession } = require('../whatsapp/engine');
    await disconnectSession(userId);
    
    res.json(formatResponse(true, 'All sessions cleared. Please try connecting again.'));
  } catch (err) {
    console.error('[WhatsApp] Force reset error:', err);
    next(err);
  }
});
/**
 * POST /api/whatsapp/pair
 * Pair WhatsApp using phone number (8-digit code)
 */
router.post('/pair', protect, async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
      return res.status(400).json(formatResponse(false, 'Phone number required'));
    }
    
    const io = req.app.get('io');
    const userId = req.user._id.toString();
    
    // Create session with pairing
    const { createSessionWithPairing } = require('../whatsapp/engine');
    await createSessionWithPairing(userId, phoneNumber, io);
    
    res.json(formatResponse(true, 'Pairing code requested. Check WhatsApp for the code.'));
  } catch (err) { 
    console.error('[WhatsApp] Pairing error:', err);
    next(err); 
  }
});

router.post('/pair', protect, async (req, res, next) => {
  try {
    let { phoneNumber } = req.body;
    
    // Clean phone number: remove +, spaces, and leading zeros
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (phoneNumber.startsWith('0')) {
      phoneNumber = phoneNumber.substring(1);
    }
    
    if (!phoneNumber || phoneNumber.length < 10) {
      return res.status(400).json(formatResponse(false, 'Invalid phone number. Use format: 2348012345678'));
    }
    
    console.log(`[WhatsApp] Pairing request for: ${phoneNumber}`);
    
    const io = req.app.get('io');
    const userId = req.user._id.toString();
    
    const { createSessionWithPairing } = require('../whatsapp/engine');
    await createSessionWithPairing(userId, phoneNumber, io);
    
    res.json(formatResponse(true, 'Pairing code requested. Check your WhatsApp.'));
  } catch (err) { 
    console.error('[WhatsApp] Pairing error:', err);
    next(err); 
  }
});

/**
 * GET /api/whatsapp/test-message
 * Test if WhatsApp can send a message
 */
router.get('/test-message', protect, async (req, res, next) => {
  try {
    const { sendMessage } = require('../whatsapp/engine');
    const testPhone = req.query.phone;
    
    if (!testPhone) {
      return res.status(400).json(formatResponse(false, 'Phone number required'));
    }
    
    await sendMessage(req.user._id.toString(), testPhone, "✅ Test message from WAFlow! Your WhatsApp is working properly.");
    
    res.json(formatResponse(true, 'Test message sent successfully! Check your phone.'));
  } catch (err) {
    console.error('[WhatsApp] Test message error:', err);
    res.json(formatResponse(false, err.message));
  }
});

module.exports = router;