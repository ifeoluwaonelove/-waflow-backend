'use strict';
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { Invoice, Receipt, Transaction } = require('../models');
const { formatResponse, paginate } = require('../utils/response');

// GET /api/invoices
router.get('/', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;
    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(invoices, total, page, limit));
  } catch (err) { next(err); }
});

// (Keep the rest of your invoice routes here...)

module.exports = router;
