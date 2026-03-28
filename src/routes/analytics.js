'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { 
  Contact, 
  Message, 
  Broadcast, 
  ContestParticipant  // Changed from ReferralParticipant to ContestParticipant
} = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

// Helper function to validate models
const validateModels = () => {
  const models = { Contact, Message, Broadcast, ContestParticipant };
  const missing = Object.entries(models)
    .filter(([name, model]) => !model || typeof model.countDocuments !== 'function')
    .map(([name]) => name);
  
  if (missing.length > 0) {
    console.error(`[Analytics] Missing or invalid models: ${missing.join(', ')}`);
    throw new Error(`Missing or invalid models: ${missing.join(', ')}`);
  }
  return true;
};

router.get('/overview', protect, async (req, res, next) => {
  try {
    // Validate models before proceeding
    validateModels();
    
    const uid = req.user._id;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    // Log for debugging
    console.log(`[Analytics] Fetching overview for user: ${uid}`);
    
    const [
      totalContacts, 
      newContacts, 
      totalSent, 
      sentWeek, 
      autoReplies, 
      totalBroadcasts, 
      referrals, 
      deletedRecovered
    ] = await Promise.all([
      Contact.countDocuments({ userId: uid, isActive: true }),
      Contact.countDocuments({ userId: uid, isActive: true, createdAt: { $gte: weekAgo } }),
      Message.countDocuments({ userId: uid, direction: 'outbound' }),
      Message.countDocuments({ userId: uid, direction: 'outbound', createdAt: { $gte: weekAgo } }),
      Message.countDocuments({ userId: uid, autoReplyId: { $ne: null } }),
      Broadcast.countDocuments({ userId: uid }),
      ContestParticipant.countDocuments({ userId: uid }), // Changed from ReferralParticipant
      Message.countDocuments({ userId: uid, isDeleted: true }),
    ]);
    
    const bStats = await Broadcast.aggregate([
      { $match: { userId: uid, status: 'sent' } },
      { $group: { 
        _id: null, 
        recipients: { $sum: '$totalRecipients' }, 
        delivered: { $sum: '$delivered' } 
      } },
    ]);
    
    const deliveryRate = bStats[0]?.recipients > 0
      ? Math.round((bStats[0].delivered / bStats[0].recipients) * 100) 
      : 0;
    
    res.json(formatResponse(true, 'OK', {
      totalContacts, 
      newContacts, 
      totalSent, 
      sentWeek,
      autoReplies, 
      totalBroadcasts, 
      referrals, 
      deletedRecovered, 
      deliveryRate,
    }));
  } catch (err) { 
    console.error('[Analytics] Overview error:', err);
    next(err); 
  }
});

router.get('/messages-chart', protect, async (req, res, next) => {
  try {
    validateModels();
    
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    if (!Message || typeof Message.aggregate !== 'function') {
      throw new Error('Message model is not properly initialized');
    }
    
    const data = await Message.aggregate([
      { $match: { userId: req.user._id, createdAt: { $gte: since } } },
      { 
        $group: { 
          _id: { 
            date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, 
            direction: '$direction' 
          }, 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { '_id.date': 1 } },
    ]);
    res.json(formatResponse(true, 'OK', { data }));
  } catch (err) { 
    console.error('[Analytics] Messages chart error:', err);
    next(err); 
  }
});

router.get('/contacts-chart', protect, async (req, res, next) => {
  try {
    validateModels();
    
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    if (!Contact || typeof Contact.aggregate !== 'function') {
      throw new Error('Contact model is not properly initialized');
    }
    
    const data = await Contact.aggregate([
      { $match: { userId: req.user._id, createdAt: { $gte: since } } },
      { 
        $group: { 
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { _id: 1 } },
    ]);
    res.json(formatResponse(true, 'OK', { data }));
  } catch (err) { 
    console.error('[Analytics] Contacts chart error:', err);
    next(err); 
  }
});

router.get('/broadcast-performance', protect, async (req, res, next) => {
  try {
    validateModels();
    
    if (!Broadcast || typeof Broadcast.find !== 'function') {
      throw new Error('Broadcast model is not properly initialized');
    }
    
    const broadcasts = await Broadcast.find({ 
      userId: req.user._id, 
      status: 'sent' 
    })
      .sort({ sentAt: -1 })
      .limit(10)
      .select('title totalRecipients delivered failed sentAt');
    
    res.json(formatResponse(true, 'OK', { broadcasts }));
  } catch (err) { 
    console.error('[Analytics] Broadcast performance error:', err);
    next(err); 
  }
});

module.exports = router;