'use strict';
/**
 * Contest Command Handler
 * Processes inbound WhatsApp messages against any active contest for a user.
 * Handles: join via REF code, get my link, check stats, withdraw (per_referral).
 * Returns { handled: bool, reply: string|null }
 */

const { Contest, ContestParticipant } = require('../models');
const {
  ensureParticipant,
  recordContestReferral,
  getParticipantStats,
  requestPayout,
  fmt,
} = require('./contestService');

// ── In-memory multi-step payout flow ─────────────────────────────────────────
const payoutStates = new Map(); // key: `${contestId}:${phone}`
const PAYOUT_TTL   = 10 * 60 * 1000; // 10 minutes

function stateKey(contestId, phone) { return `${contestId}:${phone}`; }

// ── Patterns ──────────────────────────────────────────────────────────────────
const MY_LINK_RE   = /^(ref|refer|referral|link|invite|my link)$/i;
const STATS_RE     = /^(my referrals|referrals|stats|my stats|rank|my rank)$/i;
const WITHDRAW_RE  = /^(withdraw|cashout|withdrawal|payout|my payout)$/i;
const REF_CODE_RE  = /^REF[A-Z0-9]{5,15}$/i;

// ── Main entry point ──────────────────────────────────────────────────────────
async function handleContestCommand(userId, phone, text, pushName, sock, jid) {
  if (!text) return { handled: false };

  const trimmed = text.trim();
  const lower   = trimmed.toLowerCase();

  // Find active contest(s) for this user account
  const contest = await Contest.findOne({ userId, status: 'active' }).sort({ createdAt: -1 });
  if (!contest) return { handled: false };

  // ── 1. Referral code (new person joining) ──────────────────────────────────
  if (REF_CODE_RE.test(trimmed)) {
    const result = await recordContestReferral(contest, trimmed, phone, pushName, phone);
    if (result.ok) {
      const { referrer, earning } = result;

      // Notify the referrer
      try {
        const { sessions } = require('../whatsapp/engine');
        const refSock = sessions.get(userId.toString());
        if (refSock) {
          const stats = await getParticipantStats(contest, referrer.phone);
          let notif;
          if (contest.contestType === 'leaderboard') {
            notif = `✅ *New Referral!*\n\n${pushName || 'Someone'} just joined via your link.\n\nYour referrals: *${stats?.participant?.activeReferrals || referrer.activeReferrals + 1}*\nRank: *#${stats?.rank || '—'}*\n\nSend _stats_ to see your position.`;
          } else {
            notif = `✅ *New Referral!*\n\n${pushName || 'Someone'} just joined via your link.\n\nYour referrals: *${stats?.participant?.activeReferrals || referrer.activeReferrals + 1}*\nEarnings: *${fmt(stats?.earned || referrer.totalEarned + earning)}*\n\nSend _stats_ to check your balance.`;
          }
          await refSock.sendMessage(jid, { text: notif });
        }
      } catch (e) {
        console.error('[Contest] Referrer notify error:', e.message);
      }

      // Welcome the newcomer and give them their own link
      const waNum     = contest.whatsappNumber || '';
      const { participant: newP } = await ensureParticipant(contest, phone, pushName);
      const myLink    = waNum ? `https://wa.me/${waNum}?text=${encodeURIComponent(newP.referralCode)}` : newP.referralCode;
      const welcome   = `Welcome to *${contest.name}*! 👋\n\nYou joined via a referral link.\n\n🔗 Your own referral link:\n${myLink}\n\nShare this to earn rewards too!\n\nSend *stats* anytime to check your progress.`;
      return { handled: true, reply: welcome };
    }
    // Invalid/fraud — return false so other handlers can process
    return { handled: false };
  }

  // ── Ensure sender is a participant for the remaining commands ──────────────
  const { participant, isNew } = await ensureParticipant(contest, phone, pushName);

  const waNum  = contest.whatsappNumber || '';
  const myLink = waNum
    ? `https://wa.me/${waNum}?text=${encodeURIComponent(participant.referralCode)}`
    : participant.referralCode;
  const name   = (pushName || participant.name || 'Friend').split(' ')[0];

  // ── 2. Get referral link ───────────────────────────────────────────────────
  if (MY_LINK_RE.test(lower)) {
    const reply = `Hi ${name} 👋\n\nYour referral link for *${contest.name}*:\n\n🔗 ${myLink}\n\nCode: \`${participant.referralCode}\`\n\nShare this link to earn rewards!\nSend *stats* to check your progress.`;
    return { handled: true, reply };
  }

  // ── 3. Stats command ───────────────────────────────────────────────────────
  if (STATS_RE.test(lower)) {
    const stats = await getParticipantStats(contest, phone);
    let reply;

    if (contest.contestType === 'leaderboard') {
      const prizes = (contest.prizes || []).slice(0, 3);
      const prizeText = prizes.map(p => `🏆 ${p.rank}${p.rank === 1 ? 'st' : p.rank === 2 ? 'nd' : 'rd'} place — ${fmt(p.amount)}`).join('\n');
      reply = `Hi ${name} 👋\n\n📊 *${contest.name} Leaderboard*\n\nYour referrals: *${participant.activeReferrals}*\nYour rank: *#${stats?.rank || '—'}*\n\n${prizeText ? `Prizes:\n${prizeText}\n\n` : ''}🔗 Your link:\n${myLink}\n\n_Keep sharing to climb the leaderboard!_`;
    } else {
      const minRef  = contest.minimumReferrals || 100;
      const earned  = participant.totalEarned || 0;
      const remaining = Math.max(0, minRef - participant.activeReferrals);
      const eligible  = participant.activeReferrals >= minRef;
      reply = eligible
        ? `Hi ${name} 👋\n\n🎉 *Congratulations!*\n\nYour referrals: *${participant.activeReferrals}*\nEarnings: *${fmt(earned)}*\nCycles completed: *${participant.payoutCycles}*\n\n✅ You qualify for payout!\nSend *withdraw* to request payment.`
        : `Hi ${name} 👋\n\n📊 *${contest.name}*\n\nYour referrals: *${participant.activeReferrals}*\nEarnings so far: *${fmt(earned)}*\nRequired: *${minRef}*\nRemaining: *${remaining}*\n\n🔗 Your link:\n${myLink}\n\n_Keep sharing!_`;
    }

    return { handled: true, reply };
  }

  // ── 4. Withdraw (per_referral only) ───────────────────────────────────────
  if (WITHDRAW_RE.test(lower)) {
    if (contest.contestType === 'leaderboard') {
      return { handled: true, reply: `Hi ${name} 👋\n\nThis is a *Leaderboard Contest*.\n\nPayouts are made to the top-ranked participants when the contest ends.\n\nSend *stats* to see your current rank.` };
    }

    const minRef = contest.minimumReferrals || 100;
    if (participant.activeReferrals < minRef) {
      return {
        handled: true,
        reply: `Hi ${name} 👋\n\n❌ Not eligible yet.\n\nRequired: *${minRef}* referrals\nYours: *${participant.activeReferrals}*\nRemaining: *${minRef - participant.activeReferrals}*\n\nKeep sharing your link!`,
      };
    }

    if (participant.payoutStatus === 'pending') {
      return { handled: true, reply: `⏳ You already have a pending payout request. Please wait for it to be processed.` };
    }

    // Start payout flow
    const key = stateKey(contest._id.toString(), phone);
    payoutStates.set(key, { step: 'bank_name', data: {}, startedAt: Date.now() });

    const reply = `Hi ${name} 👋\n\n✅ *Payout Request*\n\nReferrals: *${participant.activeReferrals}*\nAmount: *${fmt(participant.activeReferrals * contest.perReferralAmount)}*\n\nPlease reply with your *Bank Name:*\n_(e.g. Zenith Bank, GTBank)_`;
    return { handled: true, reply };
  }

  // ── 5. Multi-step payout flow ──────────────────────────────────────────────
  const key   = stateKey(contest._id.toString(), phone);
  const state = payoutStates.get(key);

  if (state) {
    if (Date.now() - state.startedAt > PAYOUT_TTL) {
      payoutStates.delete(key);
      return { handled: false };
    }

    if (state.step === 'bank_name') {
      state.data.bankName = trimmed;
      state.step = 'account_number';
      state.startedAt = Date.now();
      return { handled: true, reply: `Bank: *${trimmed}*\n\nNow reply with your *Account Number:*` };
    }

    if (state.step === 'account_number') {
      if (!/^\d{10,11}$/.test(trimmed)) {
        return { handled: true, reply: 'Please enter a valid 10-digit account number:' };
      }
      state.data.accountNumber = trimmed;
      state.step = 'account_name';
      state.startedAt = Date.now();
      return { handled: true, reply: `Account: *${trimmed}*\n\nNow reply with your *Account Name* (as on bank):` };
    }

    if (state.step === 'account_name') {
      state.data.accountName = trimmed;
      payoutStates.delete(key);

      try {
        const result = await requestPayout(
          contest._id,
          participant._id,
          state.data.bankName,
          state.data.accountNumber,
          state.data.accountName
        );

        if (!result.ok) {
          const msgs = {
            pending_exists: '⚠️ You already have a pending payout. Wait for it to be processed.',
            not_eligible:   '⚠️ You are not eligible yet.',
          };
          return { handled: true, reply: msgs[result.reason] || 'Could not process. Try again.' };
        }

        const { payout } = result;
        return {
          handled: true,
          reply: `✅ *Payout Request Submitted!*\n\n💰 Amount: *${fmt(payout.amount)}*\n🏦 Bank: *${payout.bankName}*\n🔢 Account: *${payout.accountNumber}*\n👤 Name: *${payout.accountName}*\n\n⏳ Under review. You will be notified once processed.\n\nThank you! 🙏`,
        };
      } catch (e) {
        console.error('[Contest] requestPayout error:', e.message);
        return { handled: true, reply: 'Could not submit payout. Please try again later.' };
      }
    }
  }

  return { handled: false };
}

module.exports = { handleContestCommand };
