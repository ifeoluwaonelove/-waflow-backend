'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ── User ──────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name:                { type: String, required: true, trim: true, maxlength: 100 },
  email:               { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:            { type: String, required: true, minlength: 8, select: false },
  role:                { type: String, enum: ['user', 'admin'], default: 'user' },
  plan:                { type: String, enum: ['starter', 'pro', 'business'], default: 'starter' },
  planExpiresAt:       { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  apiKey:              { type: String, unique: true, sparse: true },
  whatsappConnected:   { type: Boolean, default: false },
  whatsappPhone:       { type: String, default: null },
  whatsappSessionPath: { type: String, default: null, select: false },
  isActive:            { type: Boolean, default: true },
  lastLogin:           { type: Date },
  // ── Referral earnings stats ─────────────────────────────────────────────────
  referralCode:             { type: String, unique: true, sparse: true },
  totalReferralsLifetime:   { type: Number, default: 0 },
  activeReferrals:          { type: Number, default: 0 },
  paidReferrals:            { type: Number, default: 0 },
  referralCycles:           { type: Number, default: 0 },
  totalEarnings:            { type: Number, default: 0 },
  withdrawnAmount:          { type: Number, default: 0 },
}, { timestamps: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
userSchema.methods.comparePassword = function (p) { return bcrypt.compare(p, this.password); };
userSchema.methods.planLimits = function () {
  return {
    starter:  { contacts: 500,      messages: 5000,     broadcasts: 5 },
    pro:      { contacts: 5000,     messages: 50000,    broadcasts: 50 },
    business: { contacts: Infinity, messages: Infinity, broadcasts: Infinity },
  }[this.plan];
};
userSchema.methods.toJSON = function () {
  const o = this.toObject();
  delete o.password;
  delete o.whatsappSessionPath;
  return o;
};

// ── Contact ───────────────────────────────────────────────────────────────────
const contactSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  phone:          { type: String, required: true, trim: true },
  name:           { type: String, trim: true, default: null },
  generatedName:  { type: String, trim: true },
  displayName:    { type: String, trim: true },
  whatsappName:   { type: String, trim: true, default: null },
  group:          { type: String, default: 'Leads' },
  tags:           [{ type: String, trim: true }],
  notes:          { type: String, maxlength: 1000 },
  referredBy:     { type: String, default: null },
  referrerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  totalMessages:  { type: Number, default: 0 },
  lastMessageAt:  { type: Date },
  firstMessageAt: { type: Date, default: Date.now },
  isBlocked:      { type: Boolean, default: false },
  isActive:       { type: Boolean, default: true },
  isStatusViewer: { type: Boolean, default: false },
  savedNumber:    { type: Boolean, default: false },
}, { timestamps: true });

contactSchema.index({ userId: 1, phone: 1 }, { unique: true });
contactSchema.pre('save', function (next) {
  this.displayName = this.name || this.whatsappName || this.generatedName || this.phone;
  next();
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
const broadcastSchema = new mongoose.Schema({
  userId:                { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:                 { type: String, required: true, trim: true },
  messages:              [{ text: String, mediaUrl: String, mediaType: { type: String, default: null } }],
  rotationMode:          { type: String, enum: ['single', 'random', 'sequential'], default: 'single' },
  targetType:            { type: String, enum: ['all', 'group', 'tags', 'custom'], default: 'all' },
  targetGroup:           String,
  targetTags:            [String],
  targetContacts:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
  scheduledAt:           Date,
  sentAt:                Date,
  status:                { type: String, enum: ['draft', 'scheduled', 'sending', 'sent', 'failed'], default: 'draft' },
  totalRecipients:       { type: Number, default: 0 },
  delivered:             { type: Number, default: 0 },
  failed:                { type: Number, default: 0 },
  delayBetweenMessages:  { type: Number, default: 2000 },
}, { timestamps: true });

// ── AutoReply ─────────────────────────────────────────────────────────────────
const autoReplySchema = new mongoose.Schema({
  userId:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:                String,
  keywords:            [{ type: String, lowercase: true, trim: true }],
  matchType:           { type: String, enum: ['contains', 'exact', 'starts_with'], default: 'contains' },
  reply:               { type: String, required: true },
  timeRestriction:     { type: String, enum: ['always', 'business_hours', 'off_hours'], default: 'always' },
  businessHoursStart:  { type: String, default: '09:00' },
  businessHoursEnd:    { type: String, default: '18:00' },
  delayMs:             { type: Number, default: 1500 },
  status:              { type: String, enum: ['active', 'paused'], default: 'active' },
  triggerCount:        { type: Number, default: 0 },
  priority:            { type: Number, default: 0 },
}, { timestamps: true });

// ── Message ───────────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  contactId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  phone:             { type: String, required: true },
  direction:         { type: String, enum: ['inbound', 'outbound'], required: true },
  type:              { type: String, default: 'text' },
  body:              String,
  mediaUrl:          String,
  isDeleted:         { type: Boolean, default: false },
  deletedBody:       String,
  broadcastId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast' },
  autoReplyId:       { type: mongoose.Schema.Types.ObjectId, ref: 'AutoReply' },
  status:            { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'received'], default: 'pending' },
  whatsappMessageId: String,
  timestamp:         { type: Date, default: Date.now },
}, { timestamps: true });

messageSchema.index({ userId: 1, phone: 1, timestamp: -1 });

// ── Contest ───────────────────────────────────────────────────────────────────
const contestSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:        { type: String, required: true, trim: true },
  description: String,
  startDate:   { type: Date, required: true },
  endDate:     { type: Date, required: true },
  status:      { type: String, enum: ['draft', 'active', 'ended'], default: 'draft' },

  // ── Contest type ─────────────────────────────────────────────────────────────
  contestType: {
    type:    String,
    enum:    ['leaderboard', 'per_referral'],
    required: true,
    default: 'leaderboard',
  },

  // ── Leaderboard type: ranked prizes ──────────────────────────────────────────
  prizes: [{
    rank:        { type: Number, required: true }, // 1, 2, 3 …
    description: String,
    amount:      { type: Number, default: 0 },     // ₦ value
  }],

  // ── Per-referral type: earnings per head ─────────────────────────────────────
  perReferralAmount:  { type: Number, default: 50 },   // ₦ per referral
  minimumPayout:      { type: Number, default: 5000 },  // ₦ min to withdraw
  minimumReferrals:   { type: Number, default: 100 },   // auto-computed or manual

  // ── Shared settings ───────────────────────────────────────────────────────────
  whatsappNumber:  { type: String, default: '' },       // business WA number for links
  welcomeMessage:  { type: String, default: 'Welcome! 👋\nSend REF to get your referral link.' },
  antifraud:       {
    blockDuplicates: { type: Boolean, default: true },
    blockPlatformWide: { type: Boolean, default: true },
  },

  // ── Leaderboard freeze snapshot (populated when status → ended) ───────────────
  finalLeaderboard: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

contestSchema.index({ userId: 1, status: 1 });

// ── ContestParticipant ────────────────────────────────────────────────────────
// One record per person per contest.  Used for BOTH contest types.
const contestParticipantSchema = new mongoose.Schema({
  contestId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true, index: true },
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  contestType:  { type: String, enum: ['leaderboard', 'per_referral'] },

  // Identity
  name:         { type: String, required: true },
  phone:        { type: String, required: true },
  referralCode: { type: String, required: true, unique: true },

  // Recruitment chain
  referredBy:   { type: String, default: null },   // referralCode of who recruited them
  referrerId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ContestParticipant', default: null },

  // Referral counters
  activeReferrals:   { type: Number, default: 0 },
  lifetimeReferrals: { type: Number, default: 0 },
  lastReferralDate:  { type: Date, default: null },

  // Per-referral earnings
  totalEarned:   { type: Number, default: 0 },
  payoutCycles:  { type: Number, default: 0 },

  // Leaderboard rank snapshot (updated live)
  currentRank:   { type: Number, default: null },

  // Payout state (per_referral)
  payoutStatus:  { type: String, enum: ['ineligible', 'eligible', 'pending', 'paid', 'rejected'], default: 'ineligible' },
  bankName:      { type: String, default: '' },
  accountNumber: { type: String, default: '' },
  accountName:   { type: String, default: '' },
  payoutNote:    { type: String, default: '' },

  // Leaderboard payout (leaderboard)
  prizeRank:     { type: Number, default: null },   // 1, 2, 3 if winner
  prizePaid:     { type: Boolean, default: false },

  // Anti-fraud
  isFraud:       { type: Boolean, default: false },
  joinedAt:      { type: Date, default: Date.now },
}, { timestamps: true });

contestParticipantSchema.index({ contestId: 1, activeReferrals: -1 });
contestParticipantSchema.index({ contestId: 1, phone: 1 }, { unique: true });
contestParticipantSchema.index({ contestId: 1, lastReferralDate: 1 }); // for tie-breaking

// ── ContestReferral ──────────────────────────────────────────────────────────
// Immutable log of every individual referral event. Powers both types.
const contestReferralSchema = new mongoose.Schema({
  contestId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true, index: true },
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referrerId:        { type: mongoose.Schema.Types.ObjectId, ref: 'ContestParticipant', required: true },
  referralCode:      { type: String, required: true },
  referredPhone:     { type: String, required: true },
  referredName:      { type: String, default: null },
  earningGenerated:  { type: Number, default: 0 },  // ₦ for per_referral type
}, { timestamps: true });

contestReferralSchema.index({ contestId: 1, referredPhone: 1 }, { unique: true }); // global dedup per contest
contestReferralSchema.index({ referrerId: 1 });

// ── ContestPayout ────────────────────────────────────────────────────────────
// Payout request record for per_referral type (mirrors Withdrawal but contest-scoped)
const contestPayoutSchema = new mongoose.Schema({
  contestId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true, index: true },
  participantId:   { type: mongoose.Schema.Types.ObjectId, ref: 'ContestParticipant', required: true },
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  activeReferrals: { type: Number, required: true },
  amount:          { type: Number, required: true },
  bankName:        { type: String, required: true },
  accountNumber:   { type: String, required: true },
  accountName:     { type: String, required: true },
  phone:           String,
  participantName: String,
  status:          { type: String, enum: ['pending', 'approved', 'paid', 'rejected'], default: 'pending' },
  adminNote:       { type: String, default: '' },
  requestedAt:     { type: Date, default: Date.now },
  processedAt:     { type: Date, default: null },
}, { timestamps: true });

contestPayoutSchema.index({ contestId: 1, status: 1 });

// ── Schedule ──────────────────────────────────────────────────────────────────
const scheduleSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:         { type: String, enum: ['status', 'channel', 'group', 'contact'], required: true },
  title:        { type: String, trim: true },
  content:      { type: String },
  mediaUrl:     { type: String },
  mediaType:    { type: String, enum: ['image', 'video', 'document', null], default: null },
  targetGroups:   [{ jid: String, name: String }],
  targetChannels: [{ jid: String, name: String }],
  targetContacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
  scheduledAt:  { type: Date, required: true, index: true },
  timezone:     { type: String, default: 'Africa/Lagos' },
  status:       { type: String, enum: ['pending', 'sent', 'failed', 'cancelled'], default: 'pending' },
  sentAt:       Date,
  errorMessage: String,
  retryCount:   { type: Number, default: 0 },
}, { timestamps: true });

scheduleSchema.index({ userId: 1, scheduledAt: 1, status: 1 });

// ── Invoice ───────────────────────────────────────────────────────────────────
const invoiceSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invoiceNumber: { type: String, required: true },
  clientName:    { type: String, required: true, trim: true },
  clientPhone:   { type: String, trim: true },
  clientEmail:   { type: String, trim: true },
  items: [{
    description: { type: String, required: true },
    quantity:    { type: Number, default: 1 },
    unitPrice:   { type: Number, required: true },
    total:       { type: Number },
  }],
  subtotal:  { type: Number, default: 0 },
  tax:       { type: Number, default: 0 },
  discount:  { type: Number, default: 0 },
  total:     { type: Number, required: true },
  currency:  { type: String, default: '₦' },
  status:    { type: String, enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'], default: 'draft' },
  dueDate:   Date,
  paidAt:    Date,
  notes:     String,
}, { timestamps: true });

invoiceSchema.index({ userId: 1, invoiceNumber: 1 }, { unique: true });

// ── Receipt ───────────────────────────────────────────────────────────────────
const receiptSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invoiceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  receiptNumber: { type: String, required: true },
  clientName:    { type: String, required: true, trim: true },
  clientPhone:   { type: String, trim: true },
  items: [{ description: String, quantity: Number, unitPrice: Number, total: Number }],
  total:         { type: Number, required: true },
  currency:      { type: String, default: '₦' },
  paymentMethod: { type: String, default: 'Bank Transfer' },
  notes:         String,
}, { timestamps: true });

receiptSchema.index({ userId: 1, receiptNumber: 1 }, { unique: true });

// ── Transaction ───────────────────────────────────────────────────────────────
const transactionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, enum: ['income', 'expense'], required: true },
  amount:      { type: Number, required: true, min: 0 },
  description: { type: String, required: true, trim: true },
  category:    { type: String, trim: true },
  date:        { type: Date, default: Date.now },
  invoiceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  reference:   String,
}, { timestamps: true });

transactionSchema.index({ userId: 1, date: -1 });

// ── UserSettings ──────────────────────────────────────────────────────────────
const userSettingsSchema = new mongoose.Schema({
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  autoSaveContacts:  { type: Boolean, default: true },
  autoSavePrefix:    { type: String, default: 'Customer' },
  welcomeMessage:    { type: String, default: 'Hello 👋\n\nWelcome! How can we help you today?' },
  sendWelcome:       { type: Boolean, default: true },
  welcomeDelayMs:    { type: Number, default: 1000 },
  groupSyncEnabled:  { type: Boolean, default: true },
}, { timestamps: true });

// ── GroupMember ───────────────────────────────────────────────────────────────
const groupMemberSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  groupJid:  { type: String, required: true },
  groupName: { type: String },
  phone:     { type: String, required: true },
  name:      { type: String },
  extractedAt: { type: Date, default: Date.now },
}, { timestamps: true });

groupMemberSchema.index({ userId: 1, groupJid: 1, phone: 1 }, { unique: true });

// ═══════════════════════════════════════════════════════════════════════════════
// ── NEW: Affiliate Referral (per-user, platform-wide) ─────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// Tracks every successful referral a user generates via their code
const affiliateReferralSchema = new mongoose.Schema({
  // The user who owns the referral code (the referrer)
  referrerId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  referralCode:    { type: String, required: true, index: true },
  // The new person who joined via this code
  referredPhone:   { type: String, required: true },
  referredName:    { type: String, default: null },
  // Status lifecycle
  status:          { type: String, enum: ['active', 'paid', 'rejected'], default: 'active' },
  // Links to the withdrawal that paid this referral out
  withdrawalId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Withdrawal', default: null },
  paidAt:          { type: Date, default: null },
  // Anti-fraud: store the WA number that triggered the referral
  triggeredByPhone:{ type: String },
}, { timestamps: true });

affiliateReferralSchema.index({ referrerId: 1, status: 1 });
affiliateReferralSchema.index({ referralCode: 1, referredPhone: 1 }, { unique: true });

// ── Withdrawal requests ───────────────────────────────────────────────────────
const withdrawalSchema = new mongoose.Schema({
  userId:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  activeReferrals: { type: Number, required: true },  // snapshot at request time
  amount:          { type: Number, required: true },  // calculated earnings
  bankName:        { type: String, required: true, trim: true },
  accountNumber:   { type: String, required: true, trim: true },
  accountName:     { type: String, required: true, trim: true },
  status:          { type: String, enum: ['pending', 'approved', 'paid', 'rejected'], default: 'pending' },
  adminNote:       { type: String, default: '' },
  requestedAt:     { type: Date, default: Date.now },
  processedAt:     { type: Date, default: null },
  paidAt:          { type: Date, default: null },
  // Snapshot of user's phone for easy display
  userPhone:       { type: String },
  userName:        { type: String },
}, { timestamps: true });

withdrawalSchema.index({ status: 1, requestedAt: -1 });

// ── Admin platform settings ───────────────────────────────────────────────────
const adminSettingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  label: { type: String },
}, { timestamps: true });

module.exports = {
  User:                mongoose.model('User', userSchema),
  Contact:             mongoose.model('Contact', contactSchema),
  Broadcast:           mongoose.model('Broadcast', broadcastSchema),
  AutoReply:           mongoose.model('AutoReply', autoReplySchema),
  Message:             mongoose.model('Message', messageSchema),
  Contest:             mongoose.model('Contest', contestSchema),
  ContestParticipant:  mongoose.model('ContestParticipant', contestParticipantSchema),
  ContestReferral:     mongoose.model('ContestReferral', contestReferralSchema),
  ContestPayout:       mongoose.model('ContestPayout', contestPayoutSchema),
  Schedule:            mongoose.model('Schedule', scheduleSchema),
  Invoice:             mongoose.model('Invoice', invoiceSchema),
  Receipt:             mongoose.model('Receipt', receiptSchema),
  Transaction:         mongoose.model('Transaction', transactionSchema),
  UserSettings:        mongoose.model('UserSettings', userSettingsSchema),
  GroupMember:         mongoose.model('GroupMember', groupMemberSchema),
  // Affiliate system
  AffiliateReferral:   mongoose.model('AffiliateReferral', affiliateReferralSchema),
  Withdrawal:          mongoose.model('Withdrawal', withdrawalSchema),
  AdminSettings:       mongoose.model('AdminSettings', adminSettingsSchema),
};

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});
userSchema.methods.comparePassword = function (p) { return bcrypt.compare(p, this.password); };
userSchema.methods.planLimits = function () {
  return {
    starter:  { contacts: 500,      messages: 5000,     broadcasts: 5 },
    pro:      { contacts: 5000,     messages: 50000,    broadcasts: 50 },
    business: { contacts: Infinity, messages: Infinity, broadcasts: Infinity },
  }[this.plan];
};
userSchema.methods.toJSON = function () {
  const o = this.toObject();
  delete o.password;
  delete o.whatsappSessionPath;
  return o;
};

// ── Contact ───────────────────────────────────────────────────────────────────

// ── Broadcast ─────────────────────────────────────────────────────────────────
const broadcastSchema = new mongoose.Schema({
  userId:                { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  title:                 { type: String, required: true, trim: true },
  messages:              [{ text: String, mediaUrl: String, mediaType: { type: String, default: null } }],
  rotationMode:          { type: String, enum: ['single', 'random', 'sequential'], default: 'single' },
  targetType:            { type: String, enum: ['all', 'group', 'tags', 'custom'], default: 'all' },
  targetGroup:           String,
  targetTags:            [String],
  targetContacts:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
  scheduledAt:           Date,
  sentAt:                Date,
  status:                { type: String, enum: ['draft', 'scheduled', 'sending', 'sent', 'failed'], default: 'draft' },
  totalRecipients:       { type: Number, default: 0 },
  delivered:             { type: Number, default: 0 },
  failed:                { type: Number, default: 0 },
  delayBetweenMessages:  { type: Number, default: 2000 },
}, { timestamps: true });

// ── AutoReply ─────────────────────────────────────────────────────────────────
const autoReplySchema = new mongoose.Schema({
  userId:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:                String,
  keywords:            [{ type: String, lowercase: true, trim: true }],
  matchType:           { type: String, enum: ['contains', 'exact', 'starts_with'], default: 'contains' },
  reply:               { type: String, required: true },
  timeRestriction:     { type: String, enum: ['always', 'business_hours', 'off_hours'], default: 'always' },
  businessHoursStart:  { type: String, default: '09:00' },
  businessHoursEnd:    { type: String, default: '18:00' },
  delayMs:             { type: Number, default: 1500 },
  status:              { type: String, enum: ['active', 'paused'], default: 'active' },
  triggerCount:        { type: Number, default: 0 },
  priority:            { type: Number, default: 0 },
}, { timestamps: true });

// ── Message ───────────────────────────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  contactId:         { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  phone:             { type: String, required: true },
  direction:         { type: String, enum: ['inbound', 'outbound'], required: true },
  type:              { type: String, default: 'text' },
  body:              String,
  mediaUrl:          String,
  isDeleted:         { type: Boolean, default: false },
  deletedBody:       String,
  broadcastId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Broadcast' },
  autoReplyId:       { type: mongoose.Schema.Types.ObjectId, ref: 'AutoReply' },
  status:            { type: String, enum: ['pending', 'sent', 'delivered', 'read', 'failed', 'received'], default: 'pending' },
  whatsappMessageId: String,
  timestamp:         { type: Date, default: Date.now },
}, { timestamps: true });

messageSchema.index({ userId: 1, phone: 1, timestamp: -1 });

// ── Schedule (Status / Channel / Group scheduler) ─────────────────────────────
const scheduleSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:         { type: String, enum: ['status', 'channel', 'group', 'contact'], required: true },
  title:        { type: String, trim: true },
  content:      { type: String },                 // text body
  mediaUrl:     { type: String },                 // stored file path or URL
  mediaType:    { type: String, enum: ['image', 'video', 'document', null], default: null },
  // targets
  targetGroups:   [{ jid: String, name: String }],  // for group scheduler
  targetChannels: [{ jid: String, name: String }],  // for channel scheduler
  targetContacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Contact' }],
  // timing
  scheduledAt:  { type: Date, required: true, index: true },
  timezone:     { type: String, default: 'Africa/Lagos' },
  // execution
  status:       { type: String, enum: ['pending', 'sent', 'failed', 'cancelled'], default: 'pending' },
  sentAt:       Date,
  errorMessage: String,
  retryCount:   { type: Number, default: 0 },
}, { timestamps: true });

scheduleSchema.index({ userId: 1, scheduledAt: 1, status: 1 });

// ── Invoice ───────────────────────────────────────────────────────────────────
const invoiceSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invoiceNumber: { type: String, required: true },   // INV-0001
  clientName:    { type: String, required: true, trim: true },
  clientPhone:   { type: String, trim: true },
  clientEmail:   { type: String, trim: true },
  items: [{
    description: { type: String, required: true },
    quantity:    { type: Number, default: 1 },
    unitPrice:   { type: Number, required: true },
    total:       { type: Number },
  }],
  subtotal:     { type: Number, default: 0 },
  tax:          { type: Number, default: 0 },
  discount:     { type: Number, default: 0 },
  total:        { type: Number, required: true },
  currency:     { type: String, default: '₦' },
  status:       { type: String, enum: ['draft', 'sent', 'paid', 'overdue', 'cancelled'], default: 'draft' },
  dueDate:      Date,
  paidAt:       Date,
  notes:        String,
}, { timestamps: true });

invoiceSchema.index({ userId: 1, invoiceNumber: 1 }, { unique: true });

// ── Receipt ───────────────────────────────────────────────────────────────────
const receiptSchema = new mongoose.Schema({
  userId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  invoiceId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  receiptNumber: { type: String, required: true },   // REC-0001
  clientName:    { type: String, required: true, trim: true },
  clientPhone:   { type: String, trim: true },
  items: [{
    description: String,
    quantity:    Number,
    unitPrice:   Number,
    total:       Number,
  }],
  total:         { type: Number, required: true },
  currency:      { type: String, default: '₦' },
  paymentMethod: { type: String, default: 'Bank Transfer' },
  notes:         String,
}, { timestamps: true });

receiptSchema.index({ userId: 1, receiptNumber: 1 }, { unique: true });

// ── Transaction (Money Management) ───────────────────────────────────────────
const transactionSchema = new mongoose.Schema({
  userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, enum: ['income', 'expense'], required: true },
  amount:      { type: Number, required: true, min: 0 },
  description: { type: String, required: true, trim: true },
  category:    { type: String, trim: true },
  date:        { type: Date, default: Date.now },
  invoiceId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  reference:   String,
}, { timestamps: true });

transactionSchema.index({ userId: 1, date: -1 });
transactionSchema.index({ userId: 1, type: 1 });

// ── UserSettings (auto-save, welcome msg, etc.) ───────────────────────────────
const userSettingsSchema = new mongoose.Schema({
  userId:            { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  autoSaveContacts:  { type: Boolean, default: true },
  autoSavePrefix:    { type: String, default: 'Customer' },
  welcomeMessage:    { type: String, default: 'Hello 👋\n\nWelcome! How can we help you today?' },
  sendWelcome:       { type: Boolean, default: true },
  welcomeDelayMs:    { type: Number, default: 1000 },
  groupSyncEnabled:  { type: Boolean, default: true },
}, { timestamps: true });

// ── Extend Contact with new fields (no migration needed — new fields just appear) ──
// source, firstContactDate already partially handled; we'll rely on existing schema
// and add source via update.

// ── GroupMember (for extractor) ───────────────────────────────────────────────
const groupMemberSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  groupJid:  { type: String, required: true },
  groupName: { type: String },
  phone:     { type: String, required: true },
  name:      { type: String },
  extractedAt: { type: Date, default: Date.now },
}, { timestamps: true });

groupMemberSchema.index({ userId: 1, groupJid: 1, phone: 1 }, { unique: true });
