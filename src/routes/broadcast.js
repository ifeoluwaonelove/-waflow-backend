'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Broadcast } = require('../models');
const { executeBroadcast } = require('../services/schedulerService');
const { formatResponse, paginate } = require('../utils/response');
const router = express.Router();

// GET /api/broadcast
router.get('/', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };
    if (status) query.status = status;
    const total = await Broadcast.countDocuments(query);
    const broadcasts = await Broadcast.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json(paginate(broadcasts, total, page, limit));
  } catch (err) { next(err); }
});

// POST /api/broadcast
router.post('/', protect, async (req, res, next) => {
  try {
    const { title, messages, rotationMode = 'single', targetType = 'all', targetGroup, targetTags, targetContacts, scheduledAt, delayBetweenMessages = 2000 } = req.body;
    if (!title || !messages?.length) return res.status(400).json(formatResponse(false, 'title and messages are required'));
    const broadcast = await Broadcast.create({
      userId: req.user._id, title, messages, rotationMode,
      targetType, targetGroup, targetTags, targetContacts,
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      status: scheduledAt ? 'scheduled' : 'draft',
      delayBetweenMessages,
    });
    res.status(201).json(formatResponse(true, 'Broadcast created', { broadcast }));
  } catch (err) { next(err); }
});

// POST /api/broadcast/:id/send
router.post('/:id/send', protect, async (req, res, next) => {
  try {
    const broadcast = await Broadcast.findOne({ _id: req.params.id, userId: req.user._id });
    if (!broadcast) return res.status(404).json(formatResponse(false, 'Broadcast not found'));
    if (['sending', 'sent'].includes(broadcast.status)) {
      return res.status(400).json(formatResponse(false, 'Broadcast already sent or in progress'));
    }
    executeBroadcast(broadcast).catch(console.error);
    res.json(formatResponse(true, 'Broadcast started', { broadcastId: broadcast._id }));
  } catch (err) { next(err); }
});

// PATCH /api/broadcast/:id
router.patch('/:id', protect, async (req, res, next) => {
  try {
    const broadcast = await Broadcast.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: { $in: ['draft', 'scheduled'] } },
      { $set: req.body }, { new: true }
    );
    if (!broadcast) return res.status(404).json(formatResponse(false, 'Broadcast not found or already sent'));
    res.json(formatResponse(true, 'Broadcast updated', { broadcast }));
  } catch (err) { next(err); }
});

// DELETE /api/broadcast/:id
router.delete('/:id', protect, async (req, res, next) => {
  try {
    await Broadcast.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json(formatResponse(true, 'Broadcast deleted'));
  } catch (err) { next(err); }
});

module.exports = router;
