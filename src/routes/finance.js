'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Transaction } = require('../models');
const { formatResponse, paginate } = require('../utils/response');
const router = express.Router();

// GET /api/finance/transactions
router.get('/transactions', protect, async (req, res, next) => {
  try {
    const { type, category, page = 1, limit = 50, startDate, endDate } = req.query;
    const query = { userId: req.user._id };
    if (type) query.type = type;
    if (category) query.category = category;
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate)   query.date.$lte = new Date(endDate);
    }
    const total = await Transaction.countDocuments(query);
    const txns  = await Transaction.find(query).sort({ date: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(txns, total, page, limit));
  } catch (err) { next(err); }
});

// POST /api/finance/transactions
router.post('/transactions', protect, async (req, res, next) => {
  try {
    const { type, amount, description, category, date, reference } = req.body;
    if (!type || !amount || !description) return res.status(400).json(formatResponse(false, 'type, amount, description required'));
    const txn = await Transaction.create({
      userId: req.user._id,
      type, amount: parseFloat(amount), description, category,
      date: date ? new Date(date) : new Date(),
      reference,
    });
    res.status(201).json(formatResponse(true, 'Transaction recorded', { transaction: txn }));
  } catch (err) { next(err); }
});

// PATCH /api/finance/transactions/:id
router.patch('/transactions/:id', protect, async (req, res, next) => {
  try {
    const txn = await Transaction.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: req.body }, { new: true }
    );
    if (!txn) return res.status(404).json(formatResponse(false, 'Transaction not found'));
    res.json(formatResponse(true, 'Updated', { transaction: txn }));
  } catch (err) { next(err); }
});

// DELETE /api/finance/transactions/:id
router.delete('/transactions/:id', protect, async (req, res, next) => {
  try {
    await Transaction.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json(formatResponse(true, 'Transaction deleted'));
  } catch (err) { next(err); }
});

// GET /api/finance/overview — summary stats
router.get('/overview', protect, async (req, res, next) => {
  try {
    const uid = req.user._id;
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart  = new Date(now.getFullYear(), 0, 1);

    const [allTime, thisMonth, thisYear] = await Promise.all([
      Transaction.aggregate([
        { $match: { userId: uid } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { userId: uid, date: { $gte: monthStart } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { userId: uid, date: { $gte: yearStart } } },
        { $group: { _id: '$type', total: { $sum: '$amount' } } },
      ]),
    ]);

    const sum = (arr, type) => arr.find(x => x._id === type)?.total || 0;

    res.json(formatResponse(true, 'OK', {
      allTime: {
        income:  sum(allTime, 'income'),
        expense: sum(allTime, 'expense'),
        profit:  sum(allTime, 'income') - sum(allTime, 'expense'),
      },
      thisMonth: {
        income:  sum(thisMonth, 'income'),
        expense: sum(thisMonth, 'expense'),
        profit:  sum(thisMonth, 'income') - sum(thisMonth, 'expense'),
      },
      thisYear: {
        income:  sum(thisYear, 'income'),
        expense: sum(thisYear, 'expense'),
        profit:  sum(thisYear, 'income') - sum(thisYear, 'expense'),
      },
    }));
  } catch (err) { next(err); }
});

// GET /api/finance/monthly-chart — last 12 months breakdown
router.get('/monthly-chart', protect, async (req, res, next) => {
  try {
    const since = new Date();
    since.setMonth(since.getMonth() - 11);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const data = await Transaction.aggregate([
      { $match: { userId: req.user._id, date: { $gte: since } } },
      {
        $group: {
          _id: {
            year:  { $year: '$date' },
            month: { $month: '$date' },
            type:  '$type',
          },
          total: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);
    res.json(formatResponse(true, 'OK', { chart: data }));
  } catch (err) { next(err); }
});

// GET /api/finance/categories — spending by category
router.get('/categories', protect, async (req, res, next) => {
  try {
    const data = await Transaction.aggregate([
      { $match: { userId: req.user._id } },
      { $group: { _id: { category: '$category', type: '$type' }, total: { $sum: '$amount' } } },
      { $sort: { total: -1 } },
    ]);
    res.json(formatResponse(true, 'OK', { categories: data }));
  } catch (err) { next(err); }
});

/**
 * GET /api/finance/expenses/summary
 * Get expense summary for the last X days
 */
router.get('/expenses/summary', protect, async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const { getExpenseSummary } = require('../services/expenseService');
    const summary = await getExpenseSummary(req.user._id, parseInt(days));
    res.json(formatResponse(true, 'OK', { summary }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
