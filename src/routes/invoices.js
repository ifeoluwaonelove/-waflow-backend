'use strict';
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { Invoice, Receipt, Transaction } = require('../models');
const { formatResponse, paginate } = require('../utils/response');

// ── Helpers ──────────────────────────────────────────────────────────────────
async function nextInvoiceNumber(userId) {
  try {
    const last = await Invoice.findOne({ userId }).sort({ createdAt: -1 });
    if (!last || !last.invoiceNumber) return 'INV-0001';
    const n = parseInt(last.invoiceNumber.replace('INV-', '')) + 1;
    return 'INV-' + String(n).padStart(4, '0');
  } catch (e) { return 'INV-0001'; }
}

async function nextReceiptNumber(userId) {
  try {
    const last = await Receipt.findOne({ userId }).sort({ createdAt: -1 });
    if (!last || !last.receiptNumber) return 'REC-0001';
    const n = parseInt(last.receiptNumber.replace('REC-', '')) + 1;
    return 'REC-' + String(n).padStart(4, '0');
  } catch (e) { return 'REC-0001'; }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// 1. GET ALL RECEIPTS (Fixed: Now correctly defined and exported)
router.get('/receipts', protect, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const total = await Receipt.countDocuments({ userId: req.user._id });
    const receipts = await Receipt.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(receipts, total, page, limit));
  } catch (err) { next(err); }
});

// 2. GET ALL INVOICES
router.get('/', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;
    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(invoices, total, page, limit));
  } catch (err) { next(err); }
});

// 3. POST NEW INVOICE
router.post('/', protect, async (req, res, next) => {
  try {
    const { clientName, total, status } = req.body;
    const invoiceNumber = await nextInvoiceNumber(req.user._id);
    const invoice = await Invoice.create({
      userId: req.user._id,
      invoiceNumber,
      clientName,
      total,
      status: status || 'unpaid'
    });
    res.status(201).json(formatResponse(true, 'Invoice created', { invoice }));
  } catch (err) { next(err); }
});

module.exports = router;
