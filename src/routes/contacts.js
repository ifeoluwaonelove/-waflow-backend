'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Contact } = require('../models');
const { formatResponse, paginate } = require('../utils/response');
const router = express.Router();

// GET /api/contacts
router.get('/', protect, async (req, res, next) => {
  try {
    const { search = '', group, tag, page = 1, limit = 50, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    const query = { userId: req.user._id, isActive: true };
    if (search) query.$or = [
      { displayName: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
    if (group) query.group = group;
    if (tag) query.tags = tag;
    const total = await Contact.countDocuments(query);
    const contacts = await Contact.find(query)
      .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json(paginate(contacts, total, page, limit));
  } catch (err) { next(err); }
});

// POST /api/contacts
router.post('/', protect, async (req, res, next) => {
  try {
    const { phone, name, group, tags, notes } = req.body;
    if (!phone) return res.status(400).json(formatResponse(false, 'Phone is required'));
    if (await Contact.findOne({ userId: req.user._id, phone })) {
      return res.status(400).json(formatResponse(false, 'Contact already exists'));
    }
    const contact = await Contact.create({ userId: req.user._id, phone, name, group: group || 'Customers', tags: tags || [], notes });
    res.status(201).json(formatResponse(true, 'Contact created', { contact }));
  } catch (err) { next(err); }
});

// PATCH /api/contacts/:id
router.patch('/:id', protect, async (req, res, next) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!contact) return res.status(404).json(formatResponse(false, 'Contact not found'));
    res.json(formatResponse(true, 'Contact updated', { contact }));
  } catch (err) { next(err); }
});

// DELETE /api/contacts/:id
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const contact = await Contact.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { isActive: false },
      { new: true }
    );
    if (!contact) return res.status(404).json(formatResponse(false, 'Contact not found'));
    res.json(formatResponse(true, 'Contact deleted'));
  } catch (err) { next(err); }
});

// GET /api/contacts/groups
router.get('/groups', protect, async (req, res, next) => {
  try {
    const groups = await Contact.distinct('group', { userId: req.user._id, isActive: true });
    res.json(formatResponse(true, 'OK', { groups }));
  } catch (err) { next(err); }
});

// GET /api/contacts/export
router.get('/export', protect, async (req, res, next) => {
  try {
    const contacts = await Contact.find({ userId: req.user._id, isActive: true });
    const header = 'Name,Phone,Group,Tags,Joined\n';
    const rows = contacts.map(c =>
      `"${c.displayName}","${c.phone}","${c.group}","${(c.tags || []).join(';')}","${c.createdAt.toISOString()}"`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts.csv');
    res.send(header + rows);
  } catch (err) { next(err); }
});

module.exports = router;
