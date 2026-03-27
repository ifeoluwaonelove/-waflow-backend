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

// Password comparison method (Required for Login)
userSchema.methods.comparePassword = async function(candidatePassword) {
  const bcrypt = require('bcryptjs');
  return bcrypt.compare(candidatePassword, this.password);
};

// Password hashing middleware (Required for Register/Change Password)
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

// FORCE RESET MODELS
if (mongoose.models.User) delete mongoose.models.User;
if (mongoose.models.Contact) delete mongoose.models.Contact;
if (mongoose.models.Broadcast) delete mongoose.models.Broadcast;
if (mongoose.models.Contest) delete mongoose.models.Contest;

const User = mongoose.model('User', userSchema);
const Contact = mongoose.model('Contact', contactSchema);
const Broadcast = mongoose.model('Broadcast', broadcastSchema);
const Contest = mongoose.model('Contest', contestSchema);

module.exports = { User, Contact, Broadcast, Contest };
