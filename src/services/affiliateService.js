'use strict';
/**
 * Affiliate Referral Service
 * Central business logic for WAFlow's referral earning system.
 * Used by both the WhatsApp engine (command handling) and REST routes.
 */

const { User, AffiliateReferral, Withdrawal, AdminSettings, Contact, Message } = require('../models');

// ── Admin settings helpers ────────────────────────────────────────────────────

const DEFAULTS = {
  minimumReferralWithdrawal: 100,
  amountPerReferral: 50,         // ₦ per active referral
  minimumWithdrawalAmount: 5000, // ₦ minimum payout
  whatsappNumber: '',            // e.g. "2348012345678" (no +)
};

async function getAdminSetting(key) {
  try {
    const doc = await AdminSettings.findOne({ key });
    return doc ? doc.value : DEFAULTS[key];
  } catch {
    return DEFAULTS[key];
  }
}

async function getAdminSettings() {
  const keys = Object.keys(DEFAULTS);
  const docs  = await AdminSettings.find({ key: { $in: keys } });
  const result = { ...DEFAULTS };
  for (const d of docs) result[d.key] = d.value;
  return result;
}

// ── Referral code generator ───────────────────────────────────────────────────

function generateCode(userId) {
  // REF + last 6 chars of MongoDB ObjectId + 2-char random suffix = ~REF10234A
  const base   = userId.toString().slice(-6).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 4).toUpperCase();
  return `REF${base}${suffix}`;
}

// Ensure user has a referral code; create one if missing
async function ensureReferralCode(userId) {
  let user = await User.findById(userId);
  if (!user) throw new Error('User not found');
  if (!user.referralCode) {
    let code;
    let attempts = 0;
    do {
      code = generateCode(userId.toString());
      attempts++;
      if (attempts > 10) throw new Error('Could not generate unique code');
    } while (await User.findOne({ referralCode: code }));

    user = await User.findByIdAndUpdate(userId, { referralCode: code }, { new: true });
  }
  return user;
}

// ── Build referral link for a user ───────────────────────────────────────────
async function getReferralLink(userId) {
  const user   = await ensureReferralCode(userId);
  const waNum  = await getAdminSetting('whatsappNumber');
  const link   = `https://wa.me/${waNum}?text=${encodeURIComponent(user.referralCode)}`;
  return { code: user.referralCode, link, user };
}

// ── Extract first name from display name ─────────────────────────────────────
function firstName(name) {
  if (!name) return 'Customer';
  return name.split(' ')[0];
}

// ── Record a new referral when someone joins via a code ───────────────────────
async function recordReferral(referralCode, newPhone, newName, triggeredByPhone) {
  const code = referralCode.trim().toUpperCase();

  // Find the referrer
  const referrer = await User.findOne({ referralCode: code });
  if (!referrer) return { ok: false, reason: 'invalid_code' };

  // Anti-fraud: cannot refer yourself
  if (referrer.whatsappPhone && referrer.whatsappPhone.replace(/\D/g, '') === newPhone.replace(/\D/g, '')) {
    return { ok: false, reason: 'self_referral' };
  }

  // Anti-fraud: duplicate number
  const exists = await AffiliateReferral.findOne({ referralCode: code, referredPhone: newPhone });
  if (exists) return { ok: false, reason: 'duplicate' };

  // Anti-fraud: this phone has been referred by ANYONE on the platform (ever)
  const alreadyReferred = await AffiliateReferral.findOne({ referredPhone: newPhone });
  if (alreadyReferred) return { ok: false, reason: 'already_counted' };

  // Create referral record
  const referral = await AffiliateReferral.create({
    referrerId:      referrer._id,
    referralCode:    code,
    referredPhone:   newPhone,
    referredName:    newName || null,
    triggeredByPhone,
    status: 'active',
  });

  // Increment referrer's counters
  const settings = await getAdminSettings();
  const earnings  = settings.amountPerReferral;

  await User.findByIdAndUpdate(referrer._id, {
    $inc: {
      activeReferrals:        1,
      totalReferralsLifetime: 1,
      totalEarnings:          earnings,
    },
  });

  // Auto-save the referred person as a contact under the referrer
  try {
    await Contact.findOneAndUpdate(
      { userId: referrer._id, phone: newPhone },
      {
        userId:        referrer._id,
        phone:         newPhone,
        name:          newName || null,
        displayName:   newName || newPhone,
        whatsappName:  newName || null,
        generatedName: newName || `Referral ${code}`,
        group:         'Referral Contacts',
        tags:          ['referral', code],
        referredBy:    code,
        referrerId:    referrer._id,
        firstMessageAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (e) {
    console.error('[Referral] Contact save error:', e.message);
  }

  return { ok: true, referral, referrer };
}

// ── Build stats for a user ────────────────────────────────────────────────────
async function getUserStats(userId) {
  const [user, settings] = await Promise.all([
    User.findById(userId),
    getAdminSettings(),
  ]);
  if (!user) throw new Error('User not found');

  const minReq = settings.minimumReferralWithdrawal;
  const perRef = settings.amountPerReferral;
  const active = user.activeReferrals || 0;
  const earnings = active * perRef;
  const remaining = Math.max(0, minReq - active);
  const eligible  = active >= minReq;

  return {
    user,
    settings,
    active,
    lifetime:    user.totalReferralsLifetime || 0,
    paid:        user.paidReferrals          || 0,
    cycles:      user.referralCycles         || 0,
    earnings,
    totalEarnings: user.totalEarnings        || 0,
    withdrawnAmount: user.withdrawnAmount    || 0,
    availableBalance: (user.totalEarnings || 0) - (user.withdrawnAmount || 0),
    minRequired: minReq,
    remaining,
    eligible,
  };
}

// ── Process a withdrawal request (after bank details collected) ───────────────
async function createWithdrawal(userId, bankName, accountNumber, accountName) {
  const stats = await getUserStats(userId);
  if (!stats.eligible) {
    return { ok: false, reason: 'not_eligible', stats };
  }

  // Check no pending withdrawal already exists
  const pending = await Withdrawal.findOne({ userId, status: { $in: ['pending', 'approved'] } });
  if (pending) {
    return { ok: false, reason: 'pending_exists', withdrawal: pending };
  }

  const withdrawal = await Withdrawal.create({
    userId,
    activeReferrals: stats.active,
    amount: stats.earnings,
    bankName,
    accountNumber,
    accountName,
    userPhone: stats.user.whatsappPhone,
    userName:  stats.user.name,
    status: 'pending',
  });

  return { ok: true, withdrawal, stats };
}

// ── Admin marks withdrawal as PAID — resets active referrals ─────────────────
async function markWithdrawalPaid(withdrawalId, adminNote = '') {
  const withdrawal = await Withdrawal.findById(withdrawalId).populate('userId');
  if (!withdrawal) throw new Error('Withdrawal not found');
  if (withdrawal.status === 'paid') throw new Error('Already paid');

  const user = await User.findById(withdrawal.userId);
  if (!user) throw new Error('User not found');

  const now = new Date();

  // 1. Mark all active referrals for this user as paid
  await AffiliateReferral.updateMany(
    { referrerId: user._id, status: 'active' },
    { status: 'paid', withdrawalId: withdrawal._id, paidAt: now }
  );

  // 2. Update user counters — reset active, accumulate paid
  await User.findByIdAndUpdate(user._id, {
    $inc: {
      paidReferrals:  user.activeReferrals,
      referralCycles: 1,
      withdrawnAmount: withdrawal.amount,
    },
    $set: { activeReferrals: 0 },
  });

  // 3. Mark withdrawal as paid
  withdrawal.status      = 'paid';
  withdrawal.paidAt      = now;
  withdrawal.processedAt = now;
  withdrawal.adminNote   = adminNote;
  await withdrawal.save();

  return { withdrawal, user };
}

// ── Admin rejects withdrawal ──────────────────────────────────────────────────
async function rejectWithdrawal(withdrawalId, adminNote = '') {
  const withdrawal = await Withdrawal.findByIdAndUpdate(
    withdrawalId,
    { status: 'rejected', adminNote, processedAt: new Date() },
    { new: true }
  );
  if (!withdrawal) throw new Error('Withdrawal not found');
  return withdrawal;
}

module.exports = {
  getAdminSetting,
  getAdminSettings,
  ensureReferralCode,
  getReferralLink,
  recordReferral,
  getUserStats,
  createWithdrawal,
  markWithdrawalPaid,
  rejectWithdrawal,
  firstName,
};
