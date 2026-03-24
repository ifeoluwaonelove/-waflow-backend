'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { AutoReply } = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

router.get('/', protect, async (req, res, next) => {
  try {
    const rules = await AutoReply.find({ userId: req.user._id }).sort({ priority: -1, createdAt: -1 });
    res.json(formatResponse(true, 'OK', { rules }));
  } catch (err) { next(err); }
});

router.post('/', protect, async (req, res, next) => {
  try {
    const { name, keywords, matchType = 'contains', reply, timeRestriction = 'always', businessHoursStart = '09:00', businessHoursEnd = '18:00', delayMs = 1500, priority = 0 } = req.body;
    if (!keywords?.length || !reply) return res.status(400).json(formatResponse(false, 'keywords and reply are required'));
    const rule = await AutoReply.create({ userId: req.user._id, name, keywords, matchType, reply, timeRestriction, businessHoursStart, businessHoursEnd, delayMs, priority });
    res.status(201).json(formatResponse(true, 'Rule created', { rule }));
  } catch (err) { next(err); }
});

router.patch('/:id', protect, async (req, res, next) => {
  try {
    const rule = await AutoReply.findOneAndUpdate({ _id: req.params.id, userId: req.user._id }, { $set: req.body }, { new: true });
    if (!rule) return res.status(404).json(formatResponse(false, 'Rule not found'));
    res.json(formatResponse(true, 'Rule updated', { rule }));
  } catch (err) { next(err); }
});

router.patch('/:id/toggle', protect, async (req, res, next) => {
  try {
    const rule = await AutoReply.findOne({ _id: req.params.id, userId: req.user._id });
    if (!rule) return res.status(404).json(formatResponse(false, 'Rule not found'));
    rule.status = rule.status === 'active' ? 'paused' : 'active';
    await rule.save();
    res.json(formatResponse(true, 'Rule toggled', { rule }));
  } catch (err) { next(err); }
});

router.delete('/:id', protect, async (req, res, next) => {
  try {
    await AutoReply.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json(formatResponse(true, 'Rule deleted'));
  } catch (err) { next(err); }
});

module.exports = router;
