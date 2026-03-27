'use strict';
/**
 * Contest Service
 * Handles both LEADERBOARD and PER_REFERRAL contest types.
 * Called by:  routes/contests.js  and  services/contestCommandHandler.js
 */

const {
  Contest,
  ContestParticipant,
  ContestReferral,
  ContestPayout,
  Contact,
} = require('../models');

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = n => '₦' + (Number(n) || 0).toLocaleString();

function generateCode() {
  const t  = Date.now().toString(36).toUpperCase().slice(-5);
  const r  = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `REF${t}${r}`;
}

// ── Ensure participant exists for a phone in a contest ───────────────────────
async function ensureParticipant(contest, phone, name) {
  let participant = await ContestParticipant.findOne({ contestId: contest._id, phone });
  if (participant) return { participant, isNew: false };

  let code;
  let attempts = 0;
  do {
    code = generateCode();
    attempts++;
  } while (await ContestParticipant.findOne({ referralCode: code }) && attempts < 20);

  participant = await ContestParticipant.create({
    contestId:   contest._id,
    userId:      contest.userId,
    contestType: contest.contestType,
    name:        name || phone,
    phone,
    referralCode: code,
    joinedAt:     new Date(),
  });

  // Auto-save as Contact under the business's account
  try {
    await Contact.findOneAndUpdate(
      { userId: contest.userId, phone },
      {
        userId:       contest.userId,
        phone,
        name:         name || null,
        displayName:  name || phone,
        generatedName: `${contest.name} Participant`,
        group:        'Contest Participants',
        tags:         ['contest', contest.contestType, contest._id.toString()],
        firstMessageAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (e) {
    console.error('[Contest] Contact upsert error:', e.message);
  }

  return { participant, isNew: true };
}

// ── Record a referral event ──────────────────────────────────────────────────
async function recordContestReferral(contest, referralCode, newPhone, newName, triggeredPhone) {
  const code = referralCode.trim().toUpperCase();

  // Validate contest is active
  if (contest.status !== 'active') {
    return { ok: false, reason: 'contest_not_active' };
  }

  // Find the referring participant
  const referrer = await ContestParticipant.findOne({
    contestId: contest._id,
    referralCode: code,
    isFraud: false,
  });
  if (!referrer) return { ok: false, reason: 'invalid_code' };

  // Anti-fraud: cannot refer yourself
  if (referrer.phone === newPhone) {
    return { ok: false, reason: 'self_referral' };
  }

  // Anti-fraud: this phone already recorded in THIS contest
  const alreadyInContest = await ContestReferral.findOne({ contestId: contest._id, referredPhone: newPhone });
  if (alreadyInContest) return { ok: false, reason: 'already_referred' };

  // Anti-fraud: new person cannot be a registered participant themselves (prevent chain abuse)
  // Note: they CAN later get their own code once they join

  const earning = contest.contestType === 'per_referral' ? (contest.perReferralAmount || 0) : 0;

  // Create referral log
  await ContestReferral.create({
    contestId:        contest._id,
    userId:           contest.userId,
    referrerId:       referrer._id,
    referralCode:     code,
    referredPhone:    newPhone,
    referredName:     newName || null,
    earningGenerated: earning,
  });

  // Increment referrer's counters
  const now = new Date();
  await ContestParticipant.findByIdAndUpdate(referrer._id, {
    $inc: {
      activeReferrals:   1,
      lifetimeReferrals: 1,
      totalEarned:       earning,
    },
    $set: { lastReferralDate: now },
  });

  // For per_referral: update eligibility
  if (contest.contestType === 'per_referral') {
    const updated = await ContestParticipant.findById(referrer._id);
    const minRef  = contest.minimumReferrals || 100;
    if (updated.activeReferrals >= minRef && updated.payoutStatus === 'ineligible') {
      await ContestParticipant.findByIdAndUpdate(referrer._id, { payoutStatus: 'eligible' });
    }
  }

  // Ensure the new phone is registered as a participant so they can also refer
  await ensureParticipant(contest, newPhone, newName);

  return { ok: true, referrer, earning };
}

// ── Get ranked leaderboard for a contest ─────────────────────────────────────
async function getLeaderboard(contestId, limit = 100) {
  // Sort by activeReferrals DESC, then by lastReferralDate ASC (earlier = higher)
  const participants = await ContestParticipant.find({
    contestId,
    isFraud: false,
    lifetimeReferrals: { $gt: 0 },
  })
    .sort({ activeReferrals: -1, lastReferralDate: 1 })
    .limit(limit);

  return participants.map((p, i) => ({
    ...p.toObject(),
    rank: i + 1,
  }));
}

// ── Get participant stats ────────────────────────────────────────────────────
async function getParticipantStats(contest, phone) {
  const participant = await ContestParticipant.findOne({ contestId: contest._id, phone });
  if (!participant) return null;

  if (contest.contestType === 'leaderboard') {
    const rank = await ContestParticipant.countDocuments({
      contestId:    contest._id,
      isFraud:      false,
      $or: [
        { activeReferrals: { $gt: participant.activeReferrals } },
        { activeReferrals: participant.activeReferrals, lastReferralDate: { $lt: participant.lastReferralDate || new Date() } },
      ],
    }) + 1;

    return { participant, rank, type: 'leaderboard' };
  }

  // per_referral
  const minRef  = contest.minimumReferrals || 100;
  const earned  = participant.totalEarned || 0;
  const eligible = participant.activeReferrals >= minRef;

  return { participant, eligible, minRef, earned, type: 'per_referral' };
}

// ── Process per_referral payout request ──────────────────────────────────────
async function requestPayout(contestId, participantId, bankName, accountNumber, accountName) {
  const participant = await ContestParticipant.findOne({ _id: participantId, contestId });
  if (!participant) throw new Error('Participant not found');

  if (participant.payoutStatus !== 'eligible') {
    return { ok: false, reason: 'not_eligible', participant };
  }

  // Check no pending payout exists
  const existing = await ContestPayout.findOne({ participantId, status: { $in: ['pending', 'approved'] } });
  if (existing) return { ok: false, reason: 'pending_exists' };

  const contest = await Contest.findById(contestId);
  const amount  = participant.activeReferrals * (contest.perReferralAmount || 0);

  const payout = await ContestPayout.create({
    contestId,
    participantId,
    userId:          contest.userId,
    activeReferrals: participant.activeReferrals,
    amount,
    bankName,
    accountNumber,
    accountName,
    phone:           participant.phone,
    participantName: participant.name,
    status: 'pending',
  });

  // Mark participant as pending
  await ContestParticipant.findByIdAndUpdate(participantId, {
    payoutStatus: 'pending',
    bankName, accountNumber, accountName,
  });

  return { ok: true, payout };
}

// ── Admin marks payout as paid — resets active referrals ────────────────────
async function markPayoutPaid(payoutId, adminNote = '') {
  const payout = await ContestPayout.findById(payoutId);
  if (!payout) throw new Error('Payout not found');
  if (payout.status === 'paid') throw new Error('Already paid');

  const participant = await ContestParticipant.findById(payout.participantId);

  const now = new Date();

  // Reset active referrals, increment cycles
  await ContestParticipant.findByIdAndUpdate(payout.participantId, {
    $inc: { payoutCycles: 1 },
    $set: {
      activeReferrals: 0,
      payoutStatus: 'ineligible',
    },
  });

  payout.status      = 'paid';
  payout.processedAt = now;
  payout.adminNote   = adminNote;
  await payout.save();

  return { payout, participant };
}

// ── Admin rejects payout ──────────────────────────────────────────────────────
async function rejectPayout(payoutId, adminNote = '') {
  const payout = await ContestPayout.findByIdAndUpdate(
    payoutId,
    { status: 'rejected', adminNote, processedAt: new Date() },
    { new: true }
  );
  if (!payout) throw new Error('Payout not found');

  // Restore participant to eligible so they can try again
  await ContestParticipant.findByIdAndUpdate(payout.participantId, { payoutStatus: 'eligible' });

  return payout;
}

// ── End a leaderboard contest — freeze + compute winners ─────────────────────
async function endContest(contestId) {
  const contest = await Contest.findById(contestId);
  if (!contest) throw new Error('Contest not found');

  const board = await getLeaderboard(contestId, 50);

  // Mark prize winners
  for (const entry of board) {
    const prize = (contest.prizes || []).find(p => p.rank === entry.rank);
    if (prize) {
      await ContestParticipant.findByIdAndUpdate(entry._id, { prizeRank: entry.rank });
    }
  }

  await Contest.findByIdAndUpdate(contestId, {
    status: 'ended',
    finalLeaderboard: board.slice(0, 20),
  });

  return { contest, leaderboard: board };
}

module.exports = {
  ensureParticipant,
  recordContestReferral,
  getLeaderboard,
  getParticipantStats,
  requestPayout,
  markPayoutPaid,
  rejectPayout,
  endContest,
  fmt,
};
