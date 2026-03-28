'use strict';
const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    index: true
  },
  whatsappNumber: { 
    type: String, 
    required: true,
    trim: true
  },
  sessionData: { 
    type: mongoose.Schema.Types.Mixed, 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['active', 'expired', 'revoked'], 
    default: 'active' 
  },
  lastUsed: { 
    type: Date, 
    default: Date.now 
  },
  deviceInfo: {
    platform: { type: String, default: null },
    browser: { type: String, default: null },
    version: { type: String, default: null }
  }
}, { 
  timestamps: true 
});

// Compound unique index to prevent duplicate sessions
sessionSchema.index({ userId: 1, whatsappNumber: 1 }, { unique: true });

// Index for cleaning up old sessions
sessionSchema.index({ lastUsed: -1 });
sessionSchema.index({ status: 1 });

module.exports = mongoose.model('Session', sessionSchema);