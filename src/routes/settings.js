'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { UserSettings } = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

// GET /api/settings — get or create user settings
router.get('/', protect, async (req, res, next) => {
  try {
    let settings = await UserSettings.findOne({ userId: req.user._id });
    if (!settings) {
      settings = await UserSettings.create({ userId: req.user._id });
    }
    res.json(formatResponse(true, 'OK', { settings }));
  } catch (err) { next(err); }
});

// PATCH /api/settings — update any settings field
router.patch('/', protect, async (req, res, next) => {
  try {
    const allowed = ['autoSaveContacts','autoSavePrefix','welcomeMessage','sendWelcome','welcomeDelayMs','groupSyncEnabled'];
    const update  = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    const settings = await UserSettings.findOneAndUpdate(
      { userId: req.user._id },
      { $set: update },
      { upsert: true, new: true }
    );
    res.json(formatResponse(true, 'Settings saved', { settings }));
  } catch (err) { next(err); }
});

module.exports = router;
