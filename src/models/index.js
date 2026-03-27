const mongoose = require('mongoose');

// 1. USER SCHEMA
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive: { type: Boolean, default: true },
  whatsappConnected: { type: Boolean, default: false },
  whatsappNumber: { type: String },
  whatsappName: { type: String },
  referralCode: { type: String, unique: true, sparse: true }
}, { timestamps: true });

userSchema.methods.comparePassword = async function(cp) {
  return require('bcryptjs').compare(cp, this.password);
};

// 2. CONTACTS & MESSAGES
const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: String,
  displayName: String,
  group: { type: String, default: 'Leads' }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  body: String,
  type: { type: String, enum: ['inbound', 'outbound'] }
}, { timestamps: true });

// 3. BROADCAST & SCHEDULER
const broadcastSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String,
  content: String,
  status: { type: String, default: 'pending' },
  sentCount: { type: Number, default: 0 }
}, { timestamps: true });

const scheduleSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  target: String,
  content: String,
  scheduledAt: Date,
  status: { type: String, default: 'pending' }
}, { timestamps: true });

// 4. AUTO-REPLY
const autoReplySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  keywords: [String],
  response: String,
  status: { type: String, default: 'active' }
}, { timestamps: true });

// 5. FINANCE, INVOICE & RECEIPT
const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invoiceNumber: String,
  clientName: String,
  clientPhone: String,
  total: Number,
  status: { type: String, default: 'unpaid' }
}, { timestamps: true });

const receiptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receiptNumber: String,
  clientName: String,
  total: Number
}, { timestamps: true });

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['income', 'expense'] },
  amount: Number,
  description: String
}, { timestamps: true });

// 6. CONTEST & REFERRAL (V4 MULTI-TYPE)
const contestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String,
  contestType: { type: String, default: 'leaderboard' },
  status: { type: String, default: 'active' },
  finalLeaderboard: Array
}, { timestamps: true });

const contestParticipantSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: String,
  name: String,
  activeReferrals: { type: Number, default: 0 },
  lifetimeReferrals: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  payoutStatus: { type: String, default: 'ineligible' }
}, { timestamps: true });

const contestReferralSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest' },
  referredPhone: String
}, { timestamps: true });

const contestPayoutSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest' },
  amount: Number,
  status: { type: String, default: 'pending' },
  requestedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// --- REGISTRATION & RESET ---
const m = mongoose.models;
['User', 'Contact', 'Message', 'Broadcast', 'Schedule', 'AutoReply', 'Invoice', 'Receipt', 'Transaction', 'Contest', 'ContestParticipant', 'ContestReferral', 'ContestPayout'].forEach(name => {
  if (m[name]) delete m[name];
});

const User = mongoose.model('User', userSchema);
const Contact = mongoose.model('Contact', contactSchema);
const Message = mongoose.model('Message', messageSchema);
const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const Schedule = mongoose.model('Schedule', scheduleSchema);
const AutoReply = mongoose.model('AutoReply', autoReplySchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const Receipt = mongoose.model('Receipt', receiptSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Contest = mongoose.model('Contest', contestSchema);
const ContestParticipant = mongoose.model('ContestParticipant', contestParticipantSchema);
const ContestReferral = mongoose.model('ContestReferral', contestReferralSchema);
const ContestPayout = mongoose.model('ContestPayout', contestPayoutSchema);

// Exporting aliases for older controller names
const ReferralParticipant = ContestParticipant;

// --- THE CRITICAL EXPORT LINE ---
module.exports = { 
  User, Contact, Message, Broadcast, Schedule, AutoReply, 
  Invoice, Receipt, Transaction, Contest, 
  ContestParticipant, ContestReferral, ContestPayout, ReferralParticipant 
};
