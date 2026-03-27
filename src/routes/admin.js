'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { adminOnly } = require('../middleware/admin');
const { User, AffiliateReferral, Withdrawal, AdminSettings, Contact } = require('../models');
const {
  markWithdrawalPaid,
  rejectWithdrawal,
  getAdminSettings,
} = require('../services/affiliateService');
const { sendMessage, sessions } = require('../whatsapp/engine');
const { formatResponse, paginate } = require('../utils/response');

const router = express.Router();

// All admin routes require JWT + admin role
router.use(protect, adminOnly);

// ── Platform overview ─────────────────────────────────────────────────────────

// GET /api/admin/stats
router.get('/stats', async (req, res, next) => {
  try {
    const [
      totalUsers,
      totalReferrals,
      activeReferrals,
      pendingWithdrawals,
      paidWithdrawals,
      totalPaidOut,
    ] = await Promise.all([
      User.countDocuments({ role: 'user' }),
      AffiliateReferral.countDocuments({}),
      AffiliateReferral.countDocuments({ status: 'active' }),
      Withdrawal.countDocuments({ status: 'pending' }),
      Withdrawal.countDocuments({ status: 'paid' }),
      Withdrawal.aggregate([{ $match: { status: 'paid' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);
    res.json(formatResponse(true, 'OK', {
      totalUsers,
      totalReferrals,
      activeReferrals,
      pendingWithdrawals,
      paidWithdrawals,
      totalPaidOut: totalPaidOut[0]?.total || 0,
    }));
  } catch (err) { next(err); }
});

// ── Withdrawal management ─────────────────────────────────────────────────────

// GET /api/admin/withdrawals
router.get('/withdrawals', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const query = {};
    if (status) query.status = status;
    const total = await Withdrawal.countDocuments(query);
    const items = await Withdrawal.find(query)
      .populate('userId', 'name email whatsappPhone referralCode activeReferrals')
      .sort({ requestedAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(items, total, page, limit));
  } catch (err) { next(err); }
});

// PATCH /api/admin/withdrawals/:id/approve
router.patch('/withdrawals/:id/approve', async (req, res, next) => {
  try {
    const w = await Withdrawal.findByIdAndUpdate(req.params.id, { status: 'approved', processedAt: new Date(), adminNote: req.body.note || '' }, { new: true }).populate('userId', 'name whatsappPhone');
    if (!w) return res.status(404).json(formatResponse(false, 'Not found'));
    res.json(formatResponse(true, 'Approved', { withdrawal: w }));
  } catch (err) { next(err); }
});

// PATCH /api/admin/withdrawals/:id/paid
router.patch('/withdrawals/:id/paid', async (req, res, next) => {
  try {
    const { withdrawal, user } = await markWithdrawalPaid(req.params.id, req.body.note || '');

    // Send WhatsApp notification to user if they have an active session
    if (user.whatsappPhone) {
      try {
        const userSock = sessions.get(user._id.toString());
        if (userSock) {
          const jid = user.whatsappPhone.replace('+', '').replace(/\D/g,'') + '@s.whatsapp.net';
          const msg = `Hi ${user.name.split(' ')[0]} 👋\n\n✅ *Your withdrawal has been paid!*\n\n💰 Amount: ₦${withdrawal.amount.toLocaleString()}\n👥 Paid referrals: ${withdrawal.activeReferrals}\n\n♻️ Your referral counter has been reset to 0.\nYou can start referring again and earn more!\n\nThank you for using WAFlow 🙏`;
          await userSock.sendMessage(jid, { text: msg });
        }
      } catch (e) {
        console.error('[Admin] WhatsApp notify error:', e.message);
      }
    }

    res.json(formatResponse(true, 'Marked as paid. Referrals reset.', { withdrawal }));
  } catch (err) { next(err); }
});

// PATCH /api/admin/withdrawals/:id/reject
router.patch('/withdrawals/:id/reject', async (req, res, next) => {
  try {
    const w = await rejectWithdrawal(req.params.id, req.body.note || '');

    // Notify user on WhatsApp
    const user = await User.findById(w.userId);
    if (user?.whatsappPhone) {
      try {
        const userSock = sessions.get(user._id.toString());
        if (userSock) {
          const jid = user.whatsappPhone.replace('+', '').replace(/\D/g,'') + '@s.whatsapp.net';
          const msg = `Hi ${user.name.split(' ')[0]} 👋\n\n❌ *Withdrawal Rejected*\n\nYour withdrawal request of ₦${w.amount.toLocaleString()} was rejected.\n\nReason: ${req.body.note || 'Contact support for details.'}\n\nYour referrals remain active. Please contact support if you have questions.`;
          await userSock.sendMessage(jid, { text: msg });
        }
      } catch (e) {}
    }

    res.json(formatResponse(true, 'Rejected', { withdrawal: w }));
  } catch (err) { next(err); }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

// GET /api/admin/leaderboard
router.get('/leaderboard', async (req, res, next) => {
  try {
    const top = await User.find({ role: 'user', totalReferralsLifetime: { $gt: 0 } })
      .select('name email whatsappPhone referralCode activeReferrals totalReferralsLifetime paidReferrals totalEarnings withdrawnAmount referralCycles')
      .sort({ activeReferrals: -1 })
      .limit(50);
    res.json(formatResponse(true, 'OK', { leaderboard: top.map((u, i) => ({ ...u.toObject(), rank: i + 1 })) }));
  } catch (err) { next(err); }
});

// GET /api/admin/leaderboard/export — CSV
router.get('/leaderboard/export', async (req, res, next) => {
  try {
    const users = await User.find({ totalReferralsLifetime: { $gt: 0 } })
      .select('name email whatsappPhone referralCode activeReferrals totalReferralsLifetime paidReferrals totalEarnings withdrawnAmount')
      .sort({ activeReferrals: -1 });
    const header = 'Rank,Name,Email,Phone,Code,Active,Lifetime,Paid,Total Earned,Withdrawn\n';
    const rows   = users.map((u, i) => `${i+1},"${u.name}","${u.email}","${u.whatsappPhone||''}","${u.referralCode||''}",${u.activeReferrals},${u.totalReferralsLifetime},${u.paidReferrals},${u.totalEarnings},${u.withdrawnAmount}`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=referral-leaderboard.csv');
    res.send(header + rows);
  } catch (err) { next(err); }
});

// ── Platform settings ─────────────────────────────────────────────────────────

// GET /api/admin/settings
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await getAdminSettings();
    res.json(formatResponse(true, 'OK', { settings }));
  } catch (err) { next(err); }
});

// PATCH /api/admin/settings
router.patch('/settings', async (req, res, next) => {
  try {
    const allowed = ['minimumReferralWithdrawal', 'amountPerReferral', 'minimumWithdrawalAmount', 'whatsappNumber'];
    const updates = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(
          AdminSettings.findOneAndUpdate(
            { key },
            { key, value: req.body[key], label: key },
            { upsert: true, new: true }
          )
        );
      }
    }
    await Promise.all(updates);
    const settings = await getAdminSettings();
    res.json(formatResponse(true, 'Settings updated', { settings }));
  } catch (err) { next(err); }
});

// ── Send WhatsApp message to a user ──────────────────────────────────────────

// POST /api/admin/message
router.post('/message', async (req, res, next) => {
  try {
    const { userId, message } = req.body;
    if (!userId || !message) return res.status(400).json(formatResponse(false, 'userId and message required'));
    const user = await User.findById(userId);
    if (!user?.whatsappPhone) return res.status(400).json(formatResponse(false, 'User has no WhatsApp number'));
    // Use first admin session found to send
    const adminUser = await User.findOne({ role: 'admin', whatsappConnected: true });
    if (!adminUser) return res.status(400).json(formatResponse(false, 'No admin WhatsApp session active'));
    await sendMessage(adminUser._id.toString(), user.whatsappPhone, message);
    res.json(formatResponse(true, 'Message sent'));
  } catch (err) { next(err); }
});

module.exports = router;
