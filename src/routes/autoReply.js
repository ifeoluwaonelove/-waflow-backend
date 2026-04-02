'use strict';
const express          = require('express');
const { protect }      = require('../middleware/auth');
const { AutoReply }    = require('../models');
const { formatResponse } = require('../utils/response');
const router           = express.Router();

// ── GET /api/auto-reply  ──────────────────────────────────────────────────────
router.get('/', protect, async (req, res, next) => {
  try {
    const rules = await AutoReply.find({ userId: req.user._id }).sort({ priority: -1, createdAt: -1 });
    res.json(formatResponse(true, 'OK', { rules }));
  } catch (err) { next(err); }
});

// ── POST /api/auto-reply  ─────────────────────────────────────────────────────
router.post('/', protect, async (req, res, next) => {
  try {
    const {
      name,
      keywords,
      matchType          = 'contains',
      reply,
      timeRestriction    = 'always',
      businessHoursStart = '09:00',
      businessHoursEnd   = '18:00',
      delayMs            = 1500,
      priority           = 0,
    } = req.body;

    // BUG FIX A: keywords could arrive as a comma-separated string from some
    // frontends. Normalise to an array, trim whitespace, remove empties.
    const kwArray = Array.isArray(keywords)
      ? keywords
      : String(keywords || '').split(',');

    const cleanKeywords = kwArray
      .map(k => k.toLowerCase().trim())
      .filter(Boolean);

    if (!cleanKeywords.length || !reply) {
      return res.status(400).json(formatResponse(false, 'keywords and reply are required'));
    }

    // BUG FIX B: validate matchType against allowed enum values
    const VALID_MATCH_TYPES = ['contains', 'exact', 'starts_with'];
    if (!VALID_MATCH_TYPES.includes(matchType)) {
      return res.status(400).json(formatResponse(false, `matchType must be one of: ${VALID_MATCH_TYPES.join(', ')}`));
    }

    // BUG FIX C: validate timeRestriction enum
    const VALID_RESTRICTIONS = ['always', 'business_hours', 'off_hours'];
    if (!VALID_RESTRICTIONS.includes(timeRestriction)) {
      return res.status(400).json(formatResponse(false, `timeRestriction must be one of: ${VALID_RESTRICTIONS.join(', ')}`));
    }

    const rule = await AutoReply.create({
      userId: req.user._id,
      name,
      keywords:           cleanKeywords,
      matchType,
      reply:              reply.trim(),
      timeRestriction,
      businessHoursStart,
      businessHoursEnd,
      delayMs:            Math.max(0, parseInt(delayMs) || 1500),
      priority:           parseInt(priority) || 0,
    });

    res.status(201).json(formatResponse(true, 'Rule created', { rule }));
  } catch (err) { next(err); }
});

// ── PATCH /api/auto-reply/:id  ────────────────────────────────────────────────
router.patch('/:id', protect, async (req, res, next) => {
  try {
    // BUG FIX D: normalise keywords on update too, same as on create.
    const updates = { ...req.body };

    if (updates.keywords !== undefined) {
      const kwArray = Array.isArray(updates.keywords)
        ? updates.keywords
        : String(updates.keywords || '').split(',');

      updates.keywords = kwArray
        .map(k => k.toLowerCase().trim())
        .filter(Boolean);

      if (!updates.keywords.length) {
        return res.status(400).json(formatResponse(false, 'keywords cannot be empty'));
      }
    }

    if (updates.reply !== undefined) {
      updates.reply = String(updates.reply).trim();
      if (!updates.reply) {
        return res.status(400).json(formatResponse(false, 'reply cannot be empty'));
      }
    }

    if (updates.delayMs !== undefined) {
      updates.delayMs = Math.max(0, parseInt(updates.delayMs) || 1500);
    }

    // BUG FIX E: prevent accidentally overwriting userId / triggerCount
    delete updates.userId;
    delete updates.triggerCount;
    delete updates.status; // status changes must go through /toggle

    const rule = await AutoReply.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!rule) return res.status(404).json(formatResponse(false, 'Rule not found'));

    res.json(formatResponse(true, 'Rule updated', { rule }));
  } catch (err) { next(err); }
});

// ── PATCH /api/auto-reply/:id/toggle  ────────────────────────────────────────
router.patch('/:id/toggle', protect, async (req, res, next) => {
  try {
    // BUG FIX F: use findOneAndUpdate with $set instead of save() to avoid
    // race conditions when multiple requests toggle simultaneously.
    const existing = await AutoReply.findOne({ _id: req.params.id, userId: req.user._id });
    if (!existing) return res.status(404).json(formatResponse(false, 'Rule not found'));

    const newStatus = existing.status === 'active' ? 'paused' : 'active';

    const rule = await AutoReply.findByIdAndUpdate(
      req.params.id,
      { $set: { status: newStatus } },
      { new: true }
    );

    res.json(formatResponse(true, `Rule ${newStatus}`, { rule }));
  } catch (err) { next(err); }
});

// ── DELETE /api/auto-reply/:id  ───────────────────────────────────────────────
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const deleted = await AutoReply.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!deleted) return res.status(404).json(formatResponse(false, 'Rule not found'));
    res.json(formatResponse(true, 'Rule deleted'));
  } catch (err) { next(err); }
});

module.exports = router;
