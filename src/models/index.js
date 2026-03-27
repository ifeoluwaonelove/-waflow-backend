const mongoose = require('mongoose');

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  isActive: { type: Boolean, default: true },
  whatsappConnected: { type: Boolean, default: false },
  whatsappNumber: { type: String },
  whatsappName: { type: String }
}, { timestamps: true });

userSchema.methods.comparePassword = async function(cp) {
  return require('bcryptjs').compare(cp, this.password);
};

const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  phone: String,
  displayName: String
}, { timestamps: true });

const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invoiceNumber: String,
  clientName: String,
  clientPhone: String,
  items: Array,
  total: Number,
  status: { type: String, default: 'unpaid' }
}, { timestamps: true });

// NEW: RECEIPT SCHEMA (This was missing!)
const receiptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  receiptNumber: String,
  clientName: String,
  total: Number,
  currency: { type: String, default: '₦' }
}, { timestamps: true });

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['income', 'expense'] },
  amount: Number,
  description: String
}, { timestamps: true });

const contestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: String,
  status: { type: String, default: 'active' }
}, { timestamps: true });

const contestParticipantSchema = new mongoose.Schema({
  contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest' },
  phone: String,
  activeReferrals: { type: Number, default: 0 }
}, { timestamps: true });

// --- REGISTRATION ---
const m = mongoose.models;
if (m.User) delete m.User;
if (m.Contact) delete m.Contact;
if (m.Invoice) delete m.Invoice;
if (m.Receipt) delete m.Receipt;
if (m.Transaction) delete m.Transaction;
if (m.Contest) delete m.Contest;
if (m.ContestParticipant) delete m.ContestParticipant;

const User = mongoose.model('User', userSchema);
const Contact = mongoose.model('Contact', contactSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const Receipt = mongoose.model('Receipt', receiptSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const Contest = mongoose.model('Contest', contestSchema);
const ContestParticipant = mongoose.model('ContestParticipant', contestParticipantSchema);
const ReferralParticipant = ContestParticipant; // Alias

module.exports = { User, Contact, Invoice, Receipt, Transaction, Contest, ContestParticipant, ReferralParticipant };
