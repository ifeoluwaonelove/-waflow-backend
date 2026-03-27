'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Contest, ContestParticipant, ContestReferral, ContestPayout } = require('../models');
const {
  getLeaderboard,
  endContest,
  markPayoutPaid,
  rejectPayout,
  requestPayout,
} = require('../services/contestService');
const { formatResponse, paginate } = require('../utils/response');

const router = express.Router();

// ── Contest CRUD ──────────────────────────────────────────────────────────────

// GET /api/contests
router.get('/', protect, async (req, res, next) => {
  try {
    const contests = await Contest.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(formatResponse(true, 'OK', { contests }));
  } catch (err) { next(err); }
});

// GET /api/contests/:id
router.get('/:id', protect, async (req, res, next) => {
  try {
    const contest = await Contest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!contest) return res.status(404).json(formatResponse(false, 'Contest not found'));
    res.json(formatResponse(true, 'OK', { contest }));
  } catch (err) { next(err); }
});

// POST /api/contests
router.post('/', protect, async (req, res, next) => {
  try {
    const {
      name, description, contestType = 'leaderboard',
      startDate, endDate, whatsappNumber, welcomeMessage,
      // Leaderboard
      prizes,
      // Per referral
      perReferralAmount, minimumPayout, minimumReferrals,
      antifraud,
    } = req.body;

    if (!name || !startDate || !endDate || !contestType) {
      return res.status(400).json(formatResponse(false, 'name, startDate, endDate, contestType required'));
    }

    // For per_referral: compute minimumReferrals if not provided
    let minRef = minimumReferrals;
    if (contestType === 'per_referral' && !minRef && perReferralAmount && minimumPayout) {
      minRef = Math.ceil(minimumPayout / perReferralAmount);
    }

    const now = new Date();
    const start = new Date(startDate);

    const contest = await Contest.create({
      userId:      req.user._id,
      name, description, contestType,
      startDate:   start,
      endDate:     new Date(endDate),
      status:      start <= now ? 'active' : 'draft',
      whatsappNumber:    whatsappNumber || '',
      welcomeMessage:    welcomeMessage || undefined,
      prizes:            prizes || [],
      perReferralAmount: perReferralAmount || 50,
      minimumPayout:     minimumPayout || 5000,
      minimumReferrals:  minRef || 100,
      antifraud:         antifraud || {},
    });

    res.status(201).json(formatResponse(true, 'Contest created', { contest }));
  } catch (err) { next(err); }
});

// PATCH /api/contests/:id
router.patch('/:id', protect, async (req, res, next) => {
  try {
    // Recompute minimumReferrals if relevant fields change
    const body = { ...req.body };
    if (body.perReferralAmount && body.minimumPayout && !body.minimumReferrals) {
      body.minimumReferrals = Math.ceil(body.minimumPayout / body.perReferralAmount);
    }
    const contest = await Contest.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: body },
      { new: true }
    );
    if (!contest) return res.status(404).json(formatResponse(false, 'Contest not found'));
    res.json(formatResponse(true, 'Contest updated', { contest }));
  } catch (err) { next(err); }
});

// DELETE /api/contests/:id
router.delete('/:id', protect, async (req, res, next) => {
  try {
    await Contest.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json(formatResponse(true, 'Contest deleted'));
  } catch (err) { next(err); }
});

// POST /api/contests/:id/end — freeze leaderboard and mark winners
router.post('/:id/end', protect, async (req, res, next) => {
  try {
    const result = await endContest(req.params.id);
    res.json(formatResponse(true, 'Contest ended and leaderboard frozen', result));
  } catch (err) { next(err); }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────

// GET /api/contests/:id/leaderboard
router.get('/:id/leaderboard', protect, async (req, res, next) => {
  try {
    const contest = await Contest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!contest) return res.status(404).json(formatResponse(false, 'Contest not found'));

    // Frozen contest returns stored snapshot
    if (contest.status === 'ended' && contest.finalLeaderboard) {
      return res.json(formatResponse(true, 'OK', { leaderboard: contest.finalLeaderboard, frozen: true }));
    }

    const leaderboard = await getLeaderboard(req.params.id, parseInt(req.query.limit) || 100);
    res.json(formatResponse(true, 'OK', { leaderboard, frozen: false }));
  } catch (err) { next(err); }
});

// GET /api/contests/:id/leaderboard/export — CSV
router.get('/:id/leaderboard/export', protect, async (req, res, next) => {
  try {
    const leaderboard = await getLeaderboard(req.params.id, 500);
    const header = 'Rank,Name,Phone,Active Referrals,Lifetime,Earnings,Payout Status\n';
    const rows = leaderboard.map(p =>
      `${p.rank},"${p.name}","${p.phone}",${p.activeReferrals},${p.lifetimeReferrals},${p.totalEarned},${p.payoutStatus || ''}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contest-leaderboard.csv');
    res.send(header + rows);
  } catch (err) { next(err); }
});

// ── Participants ──────────────────────────────────────────────────────────────

// GET /api/contests/:id/participants
router.get('/:id/participants', protect, async (req, res, next) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const query = { contestId: req.params.id, userId: req.user._id };
    if (status) query.payoutStatus = status;
    const total = await ContestParticipant.countDocuments(query);
    const items = await ContestParticipant.find(query)
      .sort({ activeReferrals: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(items, total, page, limit));
  } catch (err) { next(err); }
});

// ── Payouts (per_referral type) ───────────────────────────────────────────────

// GET /api/contests/:id/payouts
router.get('/:id/payouts', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const query = { contestId: req.params.id };
    if (status) query.status = status;
    const total  = await ContestPayout.countDocuments(query);
    const payouts = await ContestPayout.find(query).sort({ requestedAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(payouts, total, page, limit));
  } catch (err) { next(err); }
});

// PATCH /api/contests/:id/payouts/:payoutId/paid
router.patch('/:id/payouts/:payoutId/paid', protect, async (req, res, next) => {
  try {
    const { payout, participant } = await markPayoutPaid(req.params.payoutId, req.body.note || '');

    // WhatsApp notify participant
    const { sessions } = require('../whatsapp/engine');
    const sock = sessions.get(req.user._id.toString());
    if (sock && participant.phone) {
      try {
        const jid = participant.phone.replace('+', '').replace(/\D/g, '') + '@s.whatsapp.net';
        const msg = `✅ *Payout Sent!*\n\nHi ${(participant.name||'').split(' ')[0]} 👋\n\n💰 Amount: ₦${payout.amount.toLocaleString()}\n👥 Referrals paid: ${payout.activeReferrals}\n\n♻️ Your referral counter has been reset.\nYou can start referring again!\n\nThank you 🙏`;
        await sock.sendMessage(jid, { text: msg });
      } catch (e) { console.error('[Contest] Notify error:', e.message); }
    }

    res.json(formatResponse(true, 'Payout marked as paid, referrals reset', { payout }));
  } catch (err) { next(err); }
});

// PATCH /api/contests/:id/payouts/:payoutId/reject
router.patch('/:id/payouts/:payoutId/reject', protect, async (req, res, next) => {
  try {
    const payout = await rejectPayout(req.params.payoutId, req.body.note || '');

    const { sessions } = require('../whatsapp/engine');
    const sock = sessions.get(req.user._id.toString());
    if (sock && payout.phone) {
      try {
        const jid = payout.phone.replace('+', '').replace(/\D/g, '') + '@s.whatsapp.net';
        const msg = `❌ *Payout Rejected*\n\nYour payout of ₦${payout.amount.toLocaleString()} was rejected.\n\nReason: ${req.body.note || 'Contact support for details.'}\n\nYour referrals remain active. Please try again.`;
        await sock.sendMessage(jid, { text: msg });
      } catch (e) { console.error('[Contest] Reject notify error:', e.message); }
    }

    res.json(formatResponse(true, 'Payout rejected', { payout }));
  } catch (err) { next(err); }
});

// PATCH /api/contests/:id/payouts/:payoutId/approve
router.patch('/:id/payouts/:payoutId/approve', protect, async (req, res, next) => {
  try {
    const payout = await ContestPayout.findByIdAndUpdate(
      req.params.payoutId,
      { status: 'approved', processedAt: new Date(), adminNote: req.body.note || '' },
      { new: true }
    );
    if (!payout) return res.status(404).json(formatResponse(false, 'Payout not found'));
    res.json(formatResponse(true, 'Approved', { payout }));
  } catch (err) { next(err); }
});

// Leaderboard prize paid
// PATCH /api/contests/:id/winners/:participantId/paid
router.patch('/:id/winners/:participantId/paid', protect, async (req, res, next) => {
  try {
    const p = await ContestParticipant.findOneAndUpdate(
      { _id: req.params.participantId, contestId: req.params.id },
      { prizePaid: true },
      { new: true }
    );
    if (!p) return res.status(404).json(formatResponse(false, 'Participant not found'));

    // Notify
    const { sessions } = require('../whatsapp/engine');
    const sock = sessions.get(req.user._id.toString());
    if (sock && p.phone) {
      try {
        const jid = p.phone.replace('+', '').replace(/\D/g, '') + '@s.whatsapp.net';
        const msg = `🏆 *Prize Paid!*\n\nCongratulations ${(p.name||'').split(' ')[0]} 👋\n\nYour prize for finishing *#${p.prizeRank}* has been paid.\n\nThank you for participating! 🎉`;
        await sock.sendMessage(jid, { text: msg });
      } catch (e) {}
    }

    res.json(formatResponse(true, 'Prize marked paid', { participant: p }));
  } catch (err) { next(err); }
});

// GET /api/contests/:id/stats — contest-level analytics
router.get('/:id/stats', protect, async (req, res, next) => {
  try {
    const cid = req.params.id;
    const [
      totalParticipants,
      totalReferrals,
      pendingPayouts,
      paidPayouts,
    ] = await Promise.all([
      ContestParticipant.countDocuments({ contestId: cid, isFraud: false }),
      ContestReferral.countDocuments({ contestId: cid }),
      ContestPayout.countDocuments({ contestId: cid, status: { $in: ['pending', 'approved'] } }),
      ContestPayout.countDocuments({ contestId: cid, status: 'paid' }),
    ]);

    const topEarner = await ContestParticipant.findOne({ contestId: cid }).sort({ activeReferrals: -1 });
    const totalPaidOut = await ContestPayout.aggregate([
      { $match: { contestId: require('mongoose').Types.ObjectId.isValid(cid) ? new (require('mongoose').Types.ObjectId)(cid) : cid, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    res.json(formatResponse(true, 'OK', {
      totalParticipants,
      totalReferrals,
      pendingPayouts,
      paidPayouts,
      totalPaidOut: totalPaidOut[0]?.total || 0,
      topReferrals: topEarner?.activeReferrals || 0,
    }));
  } catch (err) { next(err); }
});

module.exports = router;
