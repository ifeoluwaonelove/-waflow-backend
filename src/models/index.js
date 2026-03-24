'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ── User ──────────────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name:                { type: String, required: true, trim: true, maxlength: 100 },
  email:               { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:            { type: String, required: true, minlength: 8, select: false },
  plan:                { type: String, enum: ['starter', 'pro', 'business'], default: 'starter' },
  planExpiresAt:       { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  apiKey:              { type: String, unique: true, sparse: true },
  whatsappConnected:   { type: Boolean, default: false },
  whatsappPhone:       { type: String, default: null },
  whatsappSessionPath: { type: String, default: null, select: false },
  isActive:            { type: Boolean, default: true },
  lastLogin:           { type: Date },
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
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:           { type: String, required: true },
  description:    String,
  startDate:      { type: Date, required: true },
  endDate:        { type: Date, required: true },
  prizes:         [{ rank: Number, description: String, amount: String }],
  status:         { type: String, enum: ['draft', 'active', 'ended'], default: 'draft' },
  welcomeMessage: { type: String, default: 'Welcome 👋\n\nTo watch our WhatsApp TV:\n1. Save this number\n2. Send DONE' },
  antifraud:      { blockDuplicates: { type: Boolean, default: true }, trackIp: { type: Boolean, default: true } },
}, { timestamps: true });

// ── ReferralParticipant ───────────────────────────────────────────────────────
const referralSchema = new mongoose.Schema({
  contestId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contactId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  name:           { type: String, required: true },
  phone:          { type: String, required: true },
  referralCode:   { type: String, required: true, unique: true },
  referredBy:     { type: String, default: null },
  referrerId:     { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralParticipant', default: null },
  totalReferrals: { type: Number, default: 0 },
  joinedAt:       { type: Date, default: Date.now },
  ipAddress:      String,
  isFraud:        { type: Boolean, default: false },
}, { timestamps: true });

referralSchema.index({ contestId: 1, totalReferrals: -1 });

module.exports = {
  User:                mongoose.model('User', userSchema),
  Contact:             mongoose.model('Contact', contactSchema),
  Broadcast:           mongoose.model('Broadcast', broadcastSchema),
  AutoReply:           mongoose.model('AutoReply', autoReplySchema),
  Message:             mongoose.model('Message', messageSchema),
  Contest:             mongoose.model('Contest', contestSchema),
  ReferralParticipant: mongoose.model('ReferralParticipant', referralSchema),
};
