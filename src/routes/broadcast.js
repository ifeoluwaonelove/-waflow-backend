'use strict';
/**
 * Broadcast routes — powered entirely by selective broadcasting.
 * The old "send to all / group / tag" mass endpoint has been removed.
 * Everything goes through contact selection → create-selective → broadcastService.
 */
const express            = require('express');
const { protect }        = require('../middleware/auth');
const { Contact, Broadcast, Message } = require('../models');
const { formatResponse } = require('../utils/response');
const router             = express.Router();

// ── GET /api/broadcast ───────────────────────────────────────────────────────
// (Kept for backwards-compat; returns list, not a useless info blob)
router.get('/', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const userId = req.user._id;

    const query = { userId };
    if (status) query.status = status;

    const skip      = (parseInt(page) - 1) * parseInt(limit);
    const pageLimit = parseInt(limit);

    const [broadcasts, total] = await Promise.all([
      Broadcast.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageLimit),
      Broadcast.countDocuments(query),
    ]);

    res.json(formatResponse(true, 'OK', {
      broadcasts,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / pageLimit),
    }));
  } catch (err) {
    console.error('[Broadcast] List error:', err);
    next(err);
  }
});

// ── GET /api/broadcast/list ──────────────────────────────────────────────────
router.get('/list', protect, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const userId = req.user._id;

    const query = { userId };
    if (status) query.status = status;

    const skip      = (parseInt(page) - 1) * parseInt(limit);
    const pageLimit = parseInt(limit);

    const [broadcasts, total] = await Promise.all([
      Broadcast.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageLimit),
      Broadcast.countDocuments(query),
    ]);

    res.json(formatResponse(true, 'OK', {
      broadcasts,
      total,
      page:       parseInt(page),
      totalPages: Math.ceil(total / pageLimit),
    }));
  } catch (err) {
    console.error('[Broadcast] List error:', err);
    next(err);
  }
});

// ── GET /api/broadcast/stats/contacts ───────────────────────────────────────
router.get('/stats/contacts', protect, async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [totalContacts, activeContacts, tagsList, groupsList, recentActive] = await Promise.all([
      Contact.countDocuments({ userId, isActive: true }),
      Contact.countDocuments({ userId, isActive: true, lastMessageAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      Contact.distinct('tags',  { userId, isActive: true, tags:  { $ne: [] } }),
      Contact.distinct('group', { userId, isActive: true }),
      Contact.countDocuments({ userId, isActive: true, lastMessageAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }),
    ]);

    res.json(formatResponse(true, 'OK', {
      totalContacts,
      activeContacts,
      recentActive,
      totalTags:   tagsList.filter(t => t && t !== '').length,
      totalGroups: groupsList.filter(g => g && g !== '').length,
    }));
  } catch (err) {
    console.error('[Broadcast] Stats error:', err);
    next(err);
  }
});

// ── GET /api/broadcast/contacts/filtered ────────────────────────────────────
router.get('/contacts/filtered', protect, async (req, res, next) => {
  try {
    const { search = '', tags, group, recent, page = 1, limit = 50 } = req.query;
    const userId = req.user._id;

    const query = { userId, isActive: true };

    if (search.trim()) {
      query.$or = [
        { name:        { $regex: search.trim(), $options: 'i' } },
        { phone:       { $regex: search.trim(), $options: 'i' } },
        { displayName: { $regex: search.trim(), $options: 'i' } },
      ];
    }

    if (tags && tags !== 'all' && tags !== '') {
      const tagArray = tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tagArray.length) query.tags = { $in: tagArray };
    }

    if (group && group !== 'all' && group !== '') {
      query.group = group;
    }

    if (recent && recent !== 'all' && recent !== '') {
      const days = parseInt(recent);
      if (!isNaN(days)) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        query.lastMessageAt = { $gte: since };
      }
    }

    const skip      = (parseInt(page) - 1) * parseInt(limit);
    const pageLimit = parseInt(limit);

    const [contacts, total, availableTags, availableGroups] = await Promise.all([
      Contact.find(query)
        .select('name phone displayName tags group lastMessageAt createdAt')
        .sort({ lastMessageAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(pageLimit),
      Contact.countDocuments(query),
      Contact.distinct('tags',  { userId, isActive: true, tags:  { $ne: [] } }),
      Contact.distinct('group', { userId, isActive: true }),
    ]);

    res.json(formatResponse(true, 'OK', {
      contacts,
      total,
      page:            parseInt(page),
      totalPages:      Math.ceil(total / pageLimit),
      availableTags:   availableTags.filter(t => t && t !== ''),
      availableGroups: availableGroups.filter(g => g && g !== ''),
    }));
  } catch (err) {
    console.error('[Broadcast] Filtered contacts error:', err);
    next(err);
  }
});

// ── POST /api/broadcast/contacts/selected ───────────────────────────────────
router.post('/contacts/selected', protect, async (req, res, next) => {
  try {
    const { contactIds } = req.body;
    const userId = req.user._id;

    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json(formatResponse(false, 'No contact IDs provided'));
    }

    const contacts = await Contact.find({
      _id:      { $in: contactIds },
      userId,
      isActive: true,
    }).select('name phone displayName tags group');

    res.json(formatResponse(true, 'OK', { contacts }));
  } catch (err) {
    console.error('[Broadcast] Selected contacts error:', err);
    next(err);
  }
});

// ── POST /api/broadcast/create-selective (primary send endpoint) ─────────────
router.post('/create-selective', protect, async (req, res, next) => {
  try {
    const {
      title,
      messages,
      contactIds,
      delayBetweenMessages = 2000,
      scheduledAt          = null,
    } = req.body;
    const userId = req.user._id;

    if (!title?.trim()) {
      return res.status(400).json(formatResponse(false, 'Broadcast title is required'));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json(formatResponse(false, 'At least one message is required'));
    }
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json(formatResponse(false, 'No contacts selected'));
    }

    // Verify all contacts belong to user and are active
    const contacts = await Contact.find({ _id: { $in: contactIds }, userId, isActive: true });

    if (contacts.length === 0) {
      return res.status(400).json(formatResponse(false, 'None of the selected contacts are valid'));
    }

    // Silently drop invalid IDs rather than hard-failing
    const validIds = contacts.map(c => c._id);

    const broadcast = await Broadcast.create({
      userId,
      title:                title.trim(),
      messages,
      targetType:           'custom',
      targetContacts:       validIds,
      totalRecipients:      contacts.length,
      delayBetweenMessages: Math.max(500, parseInt(delayBetweenMessages) || 2000),
      scheduledAt:          scheduledAt || null,
      status:               scheduledAt ? 'scheduled' : 'draft',
    });

    // Kick off immediately if not scheduled
    if (!scheduledAt) {
      const { processBroadcast } = require('../services/broadcastService');
      processBroadcast(broadcast._id).catch(err => {
        console.error('[Broadcast] Processing error:', err);
      });
    }

    res.status(201).json(formatResponse(true, 'Broadcast created successfully', {
      broadcast: {
        id:          broadcast._id,
        title:       broadcast.title,
        recipients:  contacts.length,
        status:      broadcast.status,
        scheduledAt: broadcast.scheduledAt,
      },
    }));
  } catch (err) {
    console.error('[Broadcast] Create-selective error:', err);
    next(err);
  }
});

// ── GET /api/broadcast/:id ───────────────────────────────────────────────────
router.get('/:id', protect, async (req, res, next) => {
  try {
    const broadcast = await Broadcast.findOne({ _id: req.params.id, userId: req.user._id });
    if (!broadcast) return res.status(404).json(formatResponse(false, 'Broadcast not found'));
    res.json(formatResponse(true, 'OK', { broadcast }));
  } catch (err) {
    console.error('[Broadcast] Get single error:', err);
    next(err);
  }
});

// ── DELETE /api/broadcast/:id ────────────────────────────────────────────────
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const broadcast = await Broadcast.findOne({ _id: req.params.id, userId: req.user._id });
    if (!broadcast) return res.status(404).json(formatResponse(false, 'Broadcast not found'));

    // Only allow deleting drafts or failed broadcasts
    if (['sending', 'scheduled'].includes(broadcast.status)) {
      return res.status(400).json(formatResponse(false, `Cannot delete a broadcast with status "${broadcast.status}"`));
    }

    await broadcast.deleteOne();
    res.json(formatResponse(true, 'Broadcast deleted'));
  } catch (err) {
    console.error('[Broadcast] Delete error:', err);
    next(err);
  }
});

module.exports = router;
