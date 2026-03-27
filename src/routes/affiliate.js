'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { AffiliateReferral, Withdrawal, Contact } = require('../models');
const {
  getReferralLink,
  getUserStats,
  createWithdrawal,
} = require('../services/affiliateService');
const { formatResponse, paginate } = require('../utils/response');

const router = express.Router();

// GET /api/affiliate/link — get or generate referral link
router.get('/link', protect, async (req, res, next) => {
  try {
    const { code, link, user } = await getReferralLink(req.user._id);
    res.json(formatResponse(true, 'OK', { code, link, user }));
  } catch (err) { next(err); }
});

// GET /api/affiliate/stats — full stats for authenticated user
router.get('/stats', protect, async (req, res, next) => {
  try {
    const stats = await getUserStats(req.user._id);
    res.json(formatResponse(true, 'OK', { stats }));
  } catch (err) { next(err); }
});

// GET /api/affiliate/referrals — list referrals this user generated
router.get('/referrals', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = { referrerId: req.user._id };
    if (status) query.status = status;
    const total   = await AffiliateReferral.countDocuments(query);
    const refs    = await AffiliateReferral.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(refs, total, page, limit));
  } catch (err) { next(err); }
});

// GET /api/affiliate/contacts — referral contacts
router.get('/contacts', protect, async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const query = { userId: req.user._id, group: 'Referral Contacts' };
    const total  = await Contact.countDocuments(query);
    const items  = await Contact.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(items, total, page, limit));
  } catch (err) { next(err); }
});

// POST /api/affiliate/withdraw — submit withdrawal request
router.post('/withdraw', protect, async (req, res, next) => {
  try {
    const { bankName, accountNumber, accountName } = req.body;
    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json(formatResponse(false, 'bankName, accountNumber, and accountName are required'));
    }
    const result = await createWithdrawal(req.user._id, bankName, accountNumber, accountName);
    if (!result.ok) {
      const msgs = {
        not_eligible:   `You need ${result.stats?.minRequired} active referrals. You have ${result.stats?.active}.`,
        pending_exists: 'You already have a pending withdrawal request.',
      };
      return res.status(400).json(formatResponse(false, msgs[result.reason] || 'Cannot process withdrawal'));
    }
    res.status(201).json(formatResponse(true, 'Withdrawal request submitted', { withdrawal: result.withdrawal }));
  } catch (err) { next(err); }
});

// GET /api/affiliate/withdrawals — user's withdrawal history
router.get('/withdrawals', protect, async (req, res, next) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const total = await Withdrawal.countDocuments({ userId: req.user._id });
    const items = await Withdrawal.find({ userId: req.user._id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(items, total, page, limit));
  } catch (err) { next(err); }
});

// GET /api/affiliate/referrals/export — CSV
router.get('/referrals/export', protect, async (req, res, next) => {
  try {
    const refs = await AffiliateReferral.find({ referrerId: req.user._id }).sort({ createdAt: -1 });
    const header = 'Phone,Name,Status,Date\n';
    const rows   = refs.map(r => `"${r.referredPhone}","${r.referredName||''}","${r.status}","${r.createdAt.toISOString()}"`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=my-referrals.csv');
    res.send(header + rows);
  } catch (err) { next(err); }
});

module.exports = router;
