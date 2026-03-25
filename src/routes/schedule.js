'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Schedule } = require('../models');
const { formatResponse, paginate } = require('../utils/response');
const router = express.Router();

// Plan limits for schedules
const SCHEDULE_LIMITS = { starter: 10, pro: 100, business: Infinity };

// GET /api/schedule
router.get('/', protect, async (req, res, next) => {
  try {
    const { type, status, page = 1, limit = 20 } = req.query;
    const query = { userId: req.user._id };
    if (type)   query.type   = type;
    if (status) query.status = status;
    const total = await Schedule.countDocuments(query);
    const items = await Schedule.find(query)
      .sort({ scheduledAt: 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(items, total, page, limit));
  } catch (err) { next(err); }
});

// POST /api/schedule
router.post('/', protect, async (req, res, next) => {
  try {
    // Plan limit check
    const limit = SCHEDULE_LIMITS[req.user.plan] || 10;
    const existing = await Schedule.countDocuments({ userId: req.user._id, status: 'pending' });
    if (existing >= limit) {
      return res.status(403).json(formatResponse(false, `Your ${req.user.plan} plan allows ${limit} pending schedules. Upgrade to schedule more.`));
    }

    const { type, title, content, mediaUrl, mediaType, targetGroups, targetChannels, targetContacts, scheduledAt, timezone } = req.body;
    if (!type || !scheduledAt) return res.status(400).json(formatResponse(false, 'type and scheduledAt are required'));
    if (!content && !mediaUrl)  return res.status(400).json(formatResponse(false, 'content or mediaUrl is required'));

    const schedule = await Schedule.create({
      userId: req.user._id,
      type, title, content, mediaUrl, mediaType,
      targetGroups:   targetGroups   || [],
      targetChannels: targetChannels || [],
      targetContacts: targetContacts || [],
      scheduledAt: new Date(scheduledAt),
      timezone: timezone || 'Africa/Lagos',
    });
    res.status(201).json(formatResponse(true, 'Schedule created', { schedule }));
  } catch (err) { next(err); }
});

// PATCH /api/schedule/:id
router.patch('/:id', protect, async (req, res, next) => {
  try {
    const schedule = await Schedule.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'pending' },
      { $set: req.body },
      { new: true }
    );
    if (!schedule) return res.status(404).json(formatResponse(false, 'Schedule not found or already sent'));
    res.json(formatResponse(true, 'Schedule updated', { schedule }));
  } catch (err) { next(err); }
});

// DELETE /api/schedule/:id
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const schedule = await Schedule.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id, status: 'pending' },
      { status: 'cancelled' },
      { new: true }
    );
    if (!schedule) return res.status(404).json(formatResponse(false, 'Schedule not found or already sent'));
    res.json(formatResponse(true, 'Schedule cancelled'));
  } catch (err) { next(err); }
});

// GET /api/schedule/calendar — returns schedules grouped by date for calendar view
router.get('/calendar', protect, async (req, res, next) => {
  try {
    const { month, year } = req.query;
    const now = new Date();
    const y = parseInt(year  || now.getFullYear());
    const m = parseInt(month || now.getMonth() + 1);
    const start = new Date(y, m - 1, 1);
    const end   = new Date(y, m,     1);

    const schedules = await Schedule.find({
      userId: req.user._id,
      scheduledAt: { $gte: start, $lt: end },
    }).sort({ scheduledAt: 1 });

    // Group by date string
    const grouped = {};
    for (const s of schedules) {
      const key = s.scheduledAt.toISOString().slice(0, 10);
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push({ _id: s._id, type: s.type, title: s.title || s.content?.slice(0, 50), status: s.status, scheduledAt: s.scheduledAt });
    }
    res.json(formatResponse(true, 'OK', { calendar: grouped }));
  } catch (err) { next(err); }
});

module.exports = router;
