'use strict';
/**
 * WhatsApp Referral Command Handler
 * Processes inbound messages for referral automation.
 * Returns { handled: bool, reply: string|null }
 */

const {
  getReferralLink,
  recordReferral,
  getUserStats,
  createWithdrawal,
  getAdminSetting,
  firstName,
} = require('./affiliateService');
const { Message } = require('../models');

// In-memory store for multi-step withdrawal flow
// key: `${userId}:${phone}` -> state object
const withdrawalStates = new Map();

// ── Message patterns ──────────────────────────────────────────────────────────
const REF_LINK_CMDS   = /^(ref|refer|referral|link|invite|my link)$/i;
const STATS_CMDS      = /^(my referrals|referrals|stats|my stats)$/i;
const WITHDRAW_CMDS   = /^(withdraw|cashout|withdrawal)$/i;
const WALLET_CMDS     = /^(wallet|balance|earnings)$/i;
const REFERRAL_CODE_RE = /^REF[A-Z0-9]{5,12}$/i;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) { return '₦' + (Number(n) || 0).toLocaleString(); }

// State key for the multi-step withdraw flow
function stateKey(userId, phone) { return `${userId}:${phone}`; }

// ── Main handler — call this for every inbound message ────────────────────────
async function handleReferralCommand(userId, phone, text, pushName, sock, jid) {
  if (!text) return { handled: false };
  const trimmed = text.trim();
  const lower   = trimmed.toLowerCase();

  // ── 1. Referral code detection (new user joining via code) ─────────────────
  if (REFERRAL_CODE_RE.test(trimmed)) {
    const result = await recordReferral(trimmed.toUpperCase(), phone, pushName, phone);
    if (result.ok) {
      const { referrer } = result;
      const name  = firstName(pushName);
      const waNum = await getAdminSetting('whatsappNumber');
      // Notify the referrer via WhatsApp (if they have a session)
      try {
        const { sessions } = require('../whatsapp/engine');
        const refSock = sessions.get(referrer._id.toString());
        if (refSock && referrer.whatsappPhone) {
          const refJid = referrer.whatsappPhone.replace('+', '').replace(/\D/g,'') + '@s.whatsapp.net';
          const stats  = await getUserStats(referrer._id.toString());
          const notif  = `✅ *New Referral!*\n\n${name} just joined via your link.\n\nActive referrals: *${stats.active}*\nEarnings: *${fmt(stats.earnings)}*\n\nSend _my referrals_ to see your full stats.`;
          await refSock.sendMessage(refJid, { text: notif });
        }
      } catch (e) {
        console.error('[Referral] Notify referrer error:', e.message);
      }
      // Reply to the new user welcoming them
      const welcome = `Welcome to WAFlow! 👋\n\nYou joined via a referral link.\n\nReply *ref* anytime to get your own referral link and start earning too!`;
      return { handled: true, reply: welcome };
    }
    // Code invalid or duplicate — don't reply, let normal flow handle it
    return { handled: false };
  }

  // ── 2. Request referral link ───────────────────────────────────────────────
  if (REF_LINK_CMDS.test(lower)) {
    try {
      const { code, link, user } = await getReferralLink(userId);
      const name = firstName(pushName || user.name);
      const reply = `Hi ${name} 👋\n\nThis is your personal referral link:\n\n🔗 ${link}\n\nShare this link to invite people.\n\nSend *my referrals* anytime to check your stats.`;
      return { handled: true, reply };
    } catch (e) {
      console.error('[Referral] getReferralLink error:', e.message);
      return { handled: true, reply: 'Sorry, could not generate your referral link. Please try again later.' };
    }
  }

  // ── 3. Stats command ──────────────────────────────────────────────────────
  if (STATS_CMDS.test(lower)) {
    try {
      const stats = await getUserStats(userId);
      const name  = firstName(pushName || stats.user.name);
      let reply;
      if (!stats.eligible) {
        reply = `Hi ${name} 👋\n\nYour referral stats:\n\nActive referrals: *${stats.active}*\nLifetime referrals: *${stats.lifetime}*\nMinimum required: *${stats.minRequired}*\nRemaining: *${stats.remaining}*\nEarnings: *${fmt(stats.earnings)}*\n\n⏳ Withdrawal status:\n_Not eligible yet. Keep sharing your link!_\n\nSend *ref* to get your referral link.`;
      } else {
        reply = `Hi ${name} 👋\n\n🎉 *Congratulations!*\n\nYour referral stats:\n\nActive referrals: *${stats.active}*\nLifetime referrals: *${stats.lifetime}*\nEarnings: *${fmt(stats.earnings)}*\n\n✅ You qualify for withdrawal!\n\nSend *withdraw* to request payment.`;
      }
      return { handled: true, reply };
    } catch (e) {
      console.error('[Referral] stats error:', e.message);
      return { handled: true, reply: 'Could not fetch your stats. Try again later.' };
    }
  }

  // ── 4. Wallet / balance command ──────────────────────────────────────────
  if (WALLET_CMDS.test(lower)) {
    try {
      const stats = await getUserStats(userId);
      const name  = firstName(pushName || stats.user.name);
      const reply = `💰 *Your WAFlow Wallet*\n\nLifetime referrals: *${stats.lifetime}*\nActive referrals: *${stats.active}*\nPaid referrals: *${stats.paid}*\nCycles completed: *${stats.cycles}*\n\nTotal earned: *${fmt(stats.totalEarnings)}*\nWithdrawn: *${fmt(stats.withdrawnAmount)}*\nAvailable balance: *${fmt(stats.availableBalance)}*`;
      return { handled: true, reply };
    } catch (e) {
      return { handled: true, reply: 'Could not fetch wallet. Try again.' };
    }
  }

  // ── 5. Withdraw command (starts multi-step flow) ──────────────────────────
  if (WITHDRAW_CMDS.test(lower)) {
    try {
      const stats = await getUserStats(userId);
      const name  = firstName(pushName || stats.user.name);

      if (!stats.eligible) {
        const reply = `Hi ${name} 👋\n\n❌ *Not eligible yet*\n\nMinimum referrals required: *${stats.minRequired}*\nYour active referrals: *${stats.active}*\nRemaining: *${stats.remaining}*\n\nKeep sharing your link and try again when you hit *${stats.minRequired}* referrals.`;
        return { handled: true, reply };
      }

      // Start withdrawal flow — ask for bank details
      withdrawalStates.set(stateKey(userId, phone), {
        step: 'bank_name',
        data: {},
        startedAt: Date.now(),
      });

      const reply = `Hi ${name} 👋\n\n✅ *Withdrawal Request*\n\nActive referrals: *${stats.active}*\nAmount: *${fmt(stats.earnings)}*\n\nPlease reply with your *Bank Name:*\n\n_(e.g. Zenith Bank, GTBank, First Bank)_`;
      return { handled: true, reply };
    } catch (e) {
      return { handled: true, reply: 'Could not process withdrawal. Try again later.' };
    }
  }

  // ── 6. Multi-step withdrawal flow ────────────────────────────────────────
  const key   = stateKey(userId, phone);
  const state = withdrawalStates.get(key);

  if (state) {
    // Expire states older than 10 minutes
    if (Date.now() - state.startedAt > 10 * 60 * 1000) {
      withdrawalStates.delete(key);
      return { handled: false };
    }

    if (state.step === 'bank_name') {
      state.data.bankName = trimmed;
      state.step = 'account_number';
      state.startedAt = Date.now();
      return { handled: true, reply: `Got it! Bank: *${trimmed}*\n\nNow reply with your *Account Number:*` };
    }

    if (state.step === 'account_number') {
      if (!/^\d{10,11}$/.test(trimmed)) {
        return { handled: true, reply: 'Please enter a valid 10-digit account number:' };
      }
      state.data.accountNumber = trimmed;
      state.step = 'account_name';
      state.startedAt = Date.now();
      return { handled: true, reply: `Account number: *${trimmed}*\n\nNow reply with your *Account Name* (as it appears on your bank):` };
    }

    if (state.step === 'account_name') {
      state.data.accountName = trimmed;
      withdrawalStates.delete(key);

      try {
        const result = await createWithdrawal(
          userId,
          state.data.bankName,
          state.data.accountNumber,
          state.data.accountName
        );

        if (!result.ok) {
          if (result.reason === 'pending_exists') {
            return { handled: true, reply: '⚠️ You already have a pending withdrawal request. Please wait for it to be processed before submitting another.' };
          }
          if (result.reason === 'not_eligible') {
            return { handled: true, reply: '⚠️ You are no longer eligible. You may need more active referrals.' };
          }
        }

        const { withdrawal, stats } = result;
        const reply = `✅ *Withdrawal Request Submitted!*\n\n📋 Request details:\n\nAmount: *${fmt(withdrawal.amount)}*\nBank: *${withdrawal.bankName}*\nAccount: *${withdrawal.accountNumber}*\nName: *${withdrawal.accountName}*\nActive referrals: *${withdrawal.activeReferrals}*\n\n⏳ Your request is being reviewed. You will be notified once it is processed.\n\nThank you for using WAFlow!`;
        return { handled: true, reply };
      } catch (e) {
        console.error('[Referral] createWithdrawal error:', e.message);
        return { handled: true, reply: 'Could not submit withdrawal. Please try again or contact support.' };
      }
    }
  }

  return { handled: false };
}

module.exports = { handleReferralCommand };
