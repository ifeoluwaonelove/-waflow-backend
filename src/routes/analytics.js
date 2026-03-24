'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Contact, Message, Broadcast, ReferralParticipant } = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

router.get('/overview', protect, async (req, res, next) => {
  try {
    const uid = req.user._id;
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [totalContacts, newContacts, totalSent, sentWeek, autoReplies, totalBroadcasts, referrals, deletedRecovered] = await Promise.all([
      Contact.countDocuments({ userId: uid, isActive: true }),
      Contact.countDocuments({ userId: uid, isActive: true, createdAt: { $gte: weekAgo } }),
      Message.countDocuments({ userId: uid, direction: 'outbound' }),
      Message.countDocuments({ userId: uid, direction: 'outbound', createdAt: { $gte: weekAgo } }),
      Message.countDocuments({ userId: uid, autoReplyId: { $ne: null } }),
      Broadcast.countDocuments({ userId: uid }),
      ReferralParticipant.countDocuments({ userId: uid }),
      Message.countDocuments({ userId: uid, isDeleted: true }),
    ]);
    const bStats = await Broadcast.aggregate([
      { $match: { userId: uid, status: 'sent' } },
      { $group: { _id: null, recipients: { $sum: '$totalRecipients' }, delivered: { $sum: '$delivered' } } },
    ]);
    const deliveryRate = bStats[0]?.recipients > 0
      ? Math.round((bStats[0].delivered / bStats[0].recipients) * 100) : 0;
    res.json(formatResponse(true, 'OK', {
      totalContacts, newContacts, totalSent, sentWeek,
      autoReplies, totalBroadcasts, referrals, deletedRecovered, deliveryRate,
    }));
  } catch (err) { next(err); }
});

router.get('/messages-chart', protect, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const data = await Message.aggregate([
      { $match: { userId: req.user._id, createdAt: { $gte: since } } },
      { $group: { _id: { date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, direction: '$direction' }, count: { $sum: 1 } } },
      { $sort: { '_id.date': 1 } },
    ]);
    res.json(formatResponse(true, 'OK', { data }));
  } catch (err) { next(err); }
});

router.get('/contacts-chart', protect, async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const data = await Contact.aggregate([
      { $match: { userId: req.user._id, createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(formatResponse(true, 'OK', { data }));
  } catch (err) { next(err); }
});

router.get('/broadcast-performance', protect, async (req, res, next) => {
  try {
    const broadcasts = await Broadcast.find({ userId: req.user._id, status: 'sent' })
      .sort({ sentAt: -1 }).limit(10).select('title totalRecipients delivered failed sentAt');
    res.json(formatResponse(true, 'OK', { broadcasts }));
  } catch (err) { next(err); }
});

module.exports = router;
