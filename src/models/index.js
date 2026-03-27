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

// 4. CONTEST SCHEMA
const contestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['leaderboard', 'per_referral'], default: 'leaderboard' },
  status: { type: String, enum: ['active', 'ended'], default: 'active' }
}, { timestamps: true });

// 5. AUTO-REPLY SCHEMA
const autoReplySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  keywords: [String],
  response: { type: String, required: true },
  status: { type: String, default: 'active' }
}, { timestamps: true });

// 6. MESSAGE SCHEMA
const messageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact' },
  body: String,
  type: { type: String, enum: ['inbound', 'outbound'] }
}, { timestamps: true });

// 7. INVOICE SCHEMA
const invoiceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientName: String,
  amount: Number,
  status: { type: String, default: 'unpaid' }
}, { timestamps: true });

// 8. TRANSACTION SCHEMA
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['income', 'expense'] },
  amount: Number,
  description: String
}, { timestamps: true });

// RESET AND REGISTER
if (mongoose.models.User) delete mongoose.models.User;
if (mongoose.models.Contact) delete mongoose.models.Contact;
if (mongoose.models.Broadcast) delete mongoose.models.Broadcast;
if (mongoose.models.Contest) delete mongoose.models.Contest;
if (mongoose.models.AutoReply) delete mongoose.models.AutoReply;
if (mongoose.models.Message) delete mongoose.models.Message;
if (mongoose.models.Invoice) delete mongoose.models.Invoice;
if (mongoose.models.Transaction) delete mongoose.models.Transaction;

const User = mongoose.model('User', userSchema);
const Contact = mongoose.model('Contact', contactSchema);
const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const Contest = mongoose.model('Contest', contestSchema);
const AutoReply = mongoose.model('AutoReply', autoReplySchema);
const Message = mongoose.model('Message', messageSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

module.exports = { User, Contact, Broadcast, Contest, AutoReply, Message, Invoice, Transaction };
