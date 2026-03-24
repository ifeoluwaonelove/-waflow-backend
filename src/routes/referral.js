'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Contest, ReferralParticipant } = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

// ── Contests ──────────────────────────────────────────────────────────────────
router.get('/contests', protect, async (req, res, next) => {
  try {
    const contests = await Contest.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json(formatResponse(true, 'OK', { contests }));
  } catch (err) { next(err); }
});

router.post('/contests', protect, async (req, res, next) => {
  try {
    const { name, description, startDate, endDate, prizes, welcomeMessage, antifraud } = req.body;
    if (!name || !startDate || !endDate) return res.status(400).json(formatResponse(false, 'name, startDate, endDate required'));
    const contest = await Contest.create({
      userId: req.user._id, name, description, startDate, endDate, prizes, welcomeMessage, antifraud,
      status: new Date(startDate) <= new Date() ? 'active' : 'draft',
    });
    res.status(201).json(formatResponse(true, 'Contest created', { contest }));
  } catch (err) { next(err); }
});

router.patch('/contests/:id', protect, async (req, res, next) => {
  try {
    const contest = await Contest.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { $set: req.body }, { new: true });
    if (!contest) return res.status(404).json(formatResponse(false, 'Contest not found'));
    res.json(formatResponse(true, 'Contest updated', { contest }));
  } catch (err) { next(err); }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
router.get('/contests/:contestId/leaderboard', protect, async (req, res, next) => {
  try {
    const participants = await ReferralParticipant.find({ contestId: req.params.contestId, userId: req.user._id, isFraud: false })
      .sort({ totalReferrals: -1 }).limit(parseInt(req.query.limit) || 50);
    const ranked = participants.map((p, i) => ({ ...p.toObject(), rank: i + 1 }));
    res.json(formatResponse(true, 'OK', { leaderboard: ranked }));
  } catch (err) { next(err); }
});

// ── Participants ──────────────────────────────────────────────────────────────
router.post('/participants', protect, async (req, res, next) => {
  try {
    const { contestId, name, phone, referredBy, ipAddress } = req.body;
    const contest = await Contest.findOne({ _id: contestId, userId: req.user._id });
    if (!contest) return res.status(404).json(formatResponse(false, 'Contest not found'));
    if (contest.antifraud?.blockDuplicates && await ReferralParticipant.findOne({ contestId, phone })) {
      return res.status(400).json(formatResponse(false, 'Phone already registered'));
    }
    const referralCode = `REF${Date.now().toString(36).toUpperCase().slice(-6)}`;
    let referrerId = null;
    if (referredBy) {
      const referrer = await ReferralParticipant.findOne({ contestId, referralCode: referredBy });
      if (referrer) {
        referrerId = referrer._id;
        await ReferralParticipant.findByIdAndUpdate(referrerId, { $inc: { totalReferrals: 1 } });
      }
    }
    const participant = await ReferralParticipant.create({ contestId, userId: req.user._id, name, phone, referralCode, referredBy: referredBy || null, referrerId, ipAddress });
    res.status(201).json(formatResponse(true, 'Participant added', { participant }));
  } catch (err) { next(err); }
});

router.get('/participants/:participantId/stats', protect, async (req, res, next) => {
  try {
    const participant = await ReferralParticipant.findOne({ _id: req.params.participantId, userId: req.user._id });
    if (!participant) return res.status(404).json(formatResponse(false, 'Participant not found'));
    const referrals = await ReferralParticipant.find({ contestId: participant.contestId, referredBy: participant.referralCode }).sort({ joinedAt: -1 });
    const aboveCount = await ReferralParticipant.countDocuments({ contestId: participant.contestId, totalReferrals: { $gt: participant.totalReferrals }, isFraud: false });
    const waLink = `https://wa.me/${(process.env.WA_BUSINESS_NUMBER || '').replace('+', '')}?text=Hello%20I%20want%20to%20join%20via%20${participant.referralCode}`;
    res.json(formatResponse(true, 'OK', { participant: { ...participant.toObject(), rank: aboveCount + 1 }, referrals, referralLink: waLink }));
  } catch (err) { next(err); }
});

// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics', protect, async (req, res, next) => {
  try {
    const totalParticipants = await ReferralParticipant.countDocuments({ userId: req.user._id, isFraud: false });
    const topReferrers = await ReferralParticipant.find({ userId: req.user._id, isFraud: false }).sort({ totalReferrals: -1 }).limit(10);
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const dailyGrowth = await ReferralParticipant.aggregate([
      { $match: { userId: req.user._id, isFraud: false, joinedAt: { $gte: twoWeeksAgo } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$joinedAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(formatResponse(true, 'OK', { totalParticipants, topReferrers, dailyGrowth }));
  } catch (err) { next(err); }
});

module.exports = router;
