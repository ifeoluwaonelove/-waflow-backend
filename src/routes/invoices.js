'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Invoice, Receipt, Transaction } = require('../models');
const { formatResponse, paginate } = require('../utils/response');
const router = express.Router();

// ── Invoice number generator ──────────────────────────────────────────────────
async function nextInvoiceNumber(userId) {
  const last = await Invoice.findOne({ userId }).sort({ createdAt: -1 }).select('invoiceNumber');
  if (!last) return 'INV-0001';
  const n = parseInt(last.invoiceNumber.replace('INV-', '')) + 1;
  return 'INV-' + String(n).padStart(4, '0');
}

async function nextReceiptNumber(userId) {
  const last = await Receipt.findOne({ userId }).sort({ createdAt: -1 }).select('receiptNumber');
  if (!last) return 'REC-0001';
  const n = parseInt(last.receiptNumber.replace('REC-', '')) + 1;
  return 'REC-' + String(n).padStart(4, '0');
}

// ── INVOICES ──────────────────────────────────────────────────────────────────

// GET /api/invoices
router.get('/', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;
    const total    = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(invoices, total, page, limit));
  } catch (err) { next(err); }
});

// POST /api/invoices
router.post('/', protect, async (req, res, next) => {
  try {
    const { clientName, clientPhone, clientEmail, items, tax = 0, discount = 0, currency = '₦', dueDate, notes } = req.body;
    if (!clientName || !items?.length) return res.status(400).json(formatResponse(false, 'clientName and items are required'));

    // Calculate totals
    const processedItems = items.map(item => ({
      ...item,
      total: (item.quantity || 1) * item.unitPrice,
    }));
    const subtotal = processedItems.reduce((s, i) => s + i.total, 0);
    const total    = subtotal + tax - discount;

    const invoiceNumber = await nextInvoiceNumber(req.user._id);
    const invoice = await Invoice.create({
      userId: req.user._id,
      invoiceNumber, clientName, clientPhone, clientEmail,
      items: processedItems, subtotal, tax, discount, total, currency,
      dueDate: dueDate ? new Date(dueDate) : undefined, notes,
    });
    res.status(201).json(formatResponse(true, 'Invoice created', { invoice }));
  } catch (err) { next(err); }
});

// PATCH /api/invoices/:id
router.patch('/:id', protect, async (req, res, next) => {
  try {
    const invoice = await Invoice.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: req.body }, { new: true }
    );
    if (!invoice) return res.status(404).json(formatResponse(false, 'Invoice not found'));

    // If marking as paid — auto-create income transaction
    if (req.body.status === 'paid' && invoice.status !== 'paid') {
      await Transaction.create({
        userId: req.user._id,
        type: 'income',
        amount: invoice.total,
        description: `Invoice ${invoice.invoiceNumber} — ${invoice.clientName}`,
        category: 'Invoice Payment',
        date: new Date(),
        invoiceId: invoice._id,
      });
    }
    res.json(formatResponse(true, 'Invoice updated', { invoice }));
  } catch (err) { next(err); }
});

// DELETE /api/invoices/:id
router.delete('/:id', protect, async (req, res, next) => {
  try {
    await Invoice.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json(formatResponse(true, 'Invoice deleted'));
  } catch (err) { next(err); }
});

// POST /api/invoices/:id/receipt — generate receipt from invoice
router.post('/:id/receipt', protect, async (req, res, next) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, userId: req.user._id });
    if (!invoice) return res.status(404).json(formatResponse(false, 'Invoice not found'));

    const receiptNumber = await nextReceiptNumber(req.user._id);
    const receipt = await Receipt.create({
      userId:        req.user._id,
      invoiceId:     invoice._id,
      receiptNumber,
      clientName:    invoice.clientName,
      clientPhone:   invoice.clientPhone,
      items:         invoice.items,
      total:         invoice.total,
      currency:      invoice.currency,
      paymentMethod: req.body.paymentMethod || 'Bank Transfer',
      notes:         req.body.notes || '',
    });

    // Mark invoice as paid
    await Invoice.findByIdAndUpdate(invoice._id, { status: 'paid', paidAt: new Date() });

    res.status(201).json(formatResponse(true, 'Receipt generated', { receipt }));
  } catch (err) { next(err); }
});

// ── RECEIPTS ──────────────────────────────────────────────────────────────────

// GET /api/invoices/receipts
router.get('/receipts', protect, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const total    = await Receipt.countDocuments({ userId: req.user._id });
    const receipts = await Receipt.find({ userId: req.user._id })
      .populate('invoiceId', 'invoiceNumber')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(receipts, total, page, limit));
  } catch (err) { next(err); }
});

module.exports = router;
