'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { User, Contact, AutoReply, Broadcast, Contest, ReferralParticipant } = require('../models');

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[Seed] Connected');

  await Promise.all([User, Contact, AutoReply, Broadcast, Contest, ReferralParticipant].map(m => m.deleteMany({})));

  const user = await User.create({
    name: 'Demo User', email: 'demo@waflow.com', password: 'password123',
    plan: 'pro', apiKey: `sk-wa-${uuidv4().replace(/-/g, '')}`,
    planExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });

  await Contact.insertMany([
    { userId: user._id, phone: '+2348012345001', name: 'Tunde Adeyemi', group: 'VIP Clients', tags: ['vip'], displayName: 'Tunde Adeyemi', totalMessages: 47 },
    { userId: user._id, phone: '+2348012345002', name: 'Mary Okonkwo', group: 'Leads', tags: ['lead'], displayName: 'Mary Okonkwo', totalMessages: 23 },
    { userId: user._id, phone: '+2348012345003', name: 'David Chukwu', group: 'Customers', tags: ['customer'], displayName: 'David Chukwu', totalMessages: 31 },
    { userId: user._id, phone: '+2348012345004', generatedName: 'Customer 001', group: 'Leads', displayName: 'Customer 001', totalMessages: 3 },
  ]);

  await AutoReply.insertMany([
    { userId: user._id, name: 'Price Enquiry', keywords: ['price', 'cost', 'how much'], reply: 'Hello 👋\n\nOur prices:\n• Starter – ₦5,000\n• Pro – ₦15,000\n• Business – ₦30,000', status: 'active', triggerCount: 234, priority: 10 },
    { userId: user._id, name: 'Greeting', keywords: ['hello', 'hi', 'hey'], reply: 'Welcome! 👋 How can we help you today?', status: 'active', triggerCount: 891, priority: 5 },
    { userId: user._id, name: 'Order Intent', keywords: ['order', 'buy', 'purchase'], reply: 'Great! 🎉 To place an order reply with your product and quantity.', status: 'active', triggerCount: 156, priority: 8 },
  ]);

  await Broadcast.insertMany([
    { userId: user._id, title: 'March Flash Sale', messages: [{ text: 'Hello {name}, check our March flash sale! 🔥' }], status: 'sent', totalRecipients: 1243, delivered: 1187, failed: 56, sentAt: new Date() },
    { userId: user._id, title: 'VIP Offer', messages: [{ text: 'Dear {name}, exclusive offer just for VIPs 👑' }], targetType: 'group', targetGroup: 'VIP Clients', status: 'draft' },
  ]);

  const contest = await Contest.create({
    userId: user._id, name: 'WhatsApp TV Growth Contest',
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 23 * 24 * 60 * 60 * 1000),
    prizes: [{ rank: 1, description: '1st Place', amount: '₦50,000' }, { rank: 2, description: '2nd Place', amount: '₦30,000' }, { rank: 3, description: '3rd Place', amount: '₦10,000' }],
    status: 'active',
  });

  await ReferralParticipant.insertMany([
    { contestId: contest._id, userId: user._id, name: 'Tunde Adeyemi', phone: '+2348012345001', referralCode: 'REF001', totalReferrals: 54 },
    { contestId: contest._id, userId: user._id, name: 'Mary Okonkwo', phone: '+2348012345002', referralCode: 'REF002', totalReferrals: 42 },
    { contestId: contest._id, userId: user._id, name: 'David Chukwu', phone: '+2348012345003', referralCode: 'REF003', totalReferrals: 37 },
  ]);

  console.log('\n✅ Seed complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Login:    demo@waflow.com');
  console.log('Password: password123');
  console.log('API Key: ', user.apiKey);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await mongoose.disconnect();
}

seed().catch(err => { console.error('[Seed]', err); process.exit(1); });
