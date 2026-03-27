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
  referralCode: { type: String, unique: true, sparse: true },
  totalEarnings: { type: Number, default: 0 }
}, { timestamps: true });

userSchema.methods.comparePassword = async function(candidatePassword) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const bcrypt = require('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// 2. CONTACT SCHEMA
const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  phone: { type: String, required: true },
  displayName: { type: String },
  group: { type: String, default: 'Leads' }
}, { timestamps: true });

// 3. BROADCAST SCHEMA
const broadcastSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  content: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  sentCount: { type: Number, default: 0 }
}, { timestamps: true });

// 4. CONTEST / REFERRAL SCHEMAS
const contestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['leaderboard', 'per_referral'], default: 'leaderboard' },
  status: { type: String, enum: ['active', 'ended'], default: 'active' }
}, { timestamps: true });

const contestParticipantSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: { type: String, required: true },
  referralCode: { type: String },
  activeReferrals: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 }
}, { timestamps: true });

// 5. SCHEDULER SCHEMA
const scheduleSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  target: { type: String, required: true },
  content: { type: String, required: true },
  scheduledAt: { type: Date, required: true },
  status: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' }
}, { timestamps: true });

// 6. INVOICE SCHEMA
const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientName: { type: String, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'unpaid' }
}, { timestamps: true });

// 7. TRANSACTION SCHEMA (FINANCE)
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['income', 'expense'], required: true },
  amount: { type: Number, required: true },
  description: { type: String }
}, { timestamps: true });

// 8. AUTO-REPLY & MESSAGE
const autoReplySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  keywords: [String],
  response: { type: String, required: true },
  status: { type: String, default: 'active' }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  body: String,
  type: { type: String, enum: ['inbound', 'outbound'] }
}, { timestamps: true });

// RESET AND REGISTER MODELS
const m = mongoose.models;
const resetModel = (name) => { if (m[name]) delete m[name]; };

['User', 'Contact', 'Broadcast', 'Contest', 'ContestParticipant', 'Schedule', 'Invoice', 'Transaction', 'AutoReply', 'Message'].forEach(resetModel);

const User = mongoose.model('User', userSchema);
const Contact = mongoose.model('Contact', contactSchema);
const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const Contest = mongoose.model('Contest', contestSchema);
const ContestParticipant = mongoose.model('ContestParticipant', contestParticipantSchema);
// Alias for older referral controller code
const ReferralParticipant = ContestParticipant;
const Schedule = mongoose.model('Schedule', scheduleSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const AutoReply = mongoose.model('AutoReply', autoReplySchema);
const Message = mongoose.model('Message', messageSchema);

module.exports = { 
  User, Contact, Broadcast, Contest, 
  ContestParticipant, ReferralParticipant, 
  Schedule, Invoice, Transaction, AutoReply, Message 
};
