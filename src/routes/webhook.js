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
/**
 * POST /api/webhook/payment
 * Webhook for payment gateway notifications (Paystack, Flutterwave, etc.)
 * This endpoint receives payment confirmations and updates invoice status
 */
router.post('/payment', async (req, res) => {
  try {
    const { 
      reference,      // Payment reference from gateway
      amount,         // Amount paid
      method,         // payment_method: card, bank_transfer, etc.
      status,         // Payment status: successful, completed, failed
      customerPhone,  // Customer's phone number
      customerEmail,  // Customer's email (optional)
      invoiceNumber   // Our invoice number (if provided)
    } = req.body;
    
    // Log received webhook for debugging
    console.log('[Webhook] Payment received:', { reference, amount, status, invoiceNumber });
    
    // Verify payment was successful
    const isSuccessful = status === 'successful' || status === 'completed' || status === 'success';
    
    if (!isSuccessful) {
      return res.json({ 
        received: true, 
        status: 'ignored', 
        message: 'Payment not successful' 
      });
    }
    
    // Find which invoice number to use
    let invNumber = invoiceNumber;
    
    // If no invoice number provided, try to extract from reference
    if (!invNumber && reference) {
      const match = reference.match(/INV-\d+/i);
      if (match) invNumber = match[0];
    }
    
    if (!invNumber) {
      console.log('[Webhook] No invoice number found in request');
      return res.json({ 
        received: true, 
        status: 'ignored', 
        message: 'No invoice number provided' 
      });
    }
    
    // Import invoice service functions
    const { processPayment, generateReceiptMessage } = require('../services/invoiceService');
    
    // Process the payment
    const result = await processPayment(invNumber, amount, method, reference);
    
    if (result.success && result.invoice && customerPhone) {
      // Send WhatsApp receipt to customer
      const receiptMessage = generateReceiptMessage(result.invoice);
      const { sessions } = require('../whatsapp/engine');
      const sock = sessions.get(result.invoice.userId.toString());
      
      if (sock) {
        const jid = customerPhone.replace('+', '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: receiptMessage });
        console.log(`[Webhook] Receipt sent to ${customerPhone}`);
      }
    }
    
    res.json({ 
      received: true, 
      success: result.success, 
      message: result.message,
      invoiceNumber: invNumber
    });
    
  } catch (err) {
    console.error('[Webhook] Payment error:', err);
    res.status(500).json({ 
      received: true, 
      success: false, 
      error: err.message 
    });
  }
});

/**
 * GET /api/webhook/payment/test
 * Test endpoint to verify webhook is working
 */
router.get('/payment/test', (req, res) => {
  res.json({ 
    message: 'Payment webhook endpoint is working', 
    timestamp: new Date().toISOString(),
    expected_body: {
      reference: 'payment_ref_123',
      amount: 5000,
      method: 'card',
      status: 'successful',
      customerPhone: '2348012345678',
      invoiceNumber: 'INV-12345678-1'
    }
  });
});
});

module.exports = router;
