const mongoose = require('mongoose');

// 1. USER SCHEMA
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  whatsappConnected: { type: Boolean, default: false },
  whatsappNumber: { type: String },
  whatsappName: { type: String },
  referralCode: { type: String, unique: true, sparse: true },
  totalEarnings: { type: Number, default: 0 }
}, { timestamps: true });

// 2. CONTACT SCHEMA
const contactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  phone: { type: String, required: true },
  displayName: { type: String },
  group: { type: String, default: 'Leads' }
}, { timestamps: true });

// 3. BROADCAST SCHEMA (ONLY ONCE)
const broadcastSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  content: { type: String, required: true },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  totalRecipients: { type: Number, default: 0 },
  sentCount: { type: Number, default: 0 }
}, { timestamps: true });

// 4. CONTEST SCHEMA
const contestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  type: { type: String, enum: ['leaderboard', 'per_referral'], default: 'leaderboard' },
  status: { type: String, enum: ['active', 'ended'], default: 'active' }
}, { timestamps: true });

// EXPORT ALL MODELS
const User = mongoose.models.User || mongoose.model('User', userSchema);
const Contact = mongoose.models.Contact || mongoose.model('Contact', contactSchema);
const Broadcast = mongoose.models.Broadcast || mongoose.model('Broadcast', broadcastSchema);
const Contest = mongoose.models.Contest || mongoose.model('Contest', contestSchema);

module.exports = { User, Contact, Broadcast, Contest };
