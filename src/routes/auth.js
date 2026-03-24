'use strict';
const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const { User } = require('../models');
const { protect } = require('../middleware/auth');
const { formatResponse } = require('../utils/response');
const router = express.Router();

const sign = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });

const validate = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json(formatResponse(false, errors.array()[0].msg));
    return false;
  }
  return true;
};

// POST /api/auth/register
router.post('/register',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be 8+ characters'),
  ],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;
      const { name, email, password } = req.body;
      if (await User.findOne({ email })) return res.status(400).json(formatResponse(false, 'Email already registered'));
      const user = await User.create({ name, email, password, apiKey: `sk-wa-${uuidv4().replace(/-/g, '')}` });
      res.status(201).json(formatResponse(true, 'Account created', { token: sign(user._id), user }));
    } catch (err) { next(err); }
  }
);

// POST /api/auth/login
router.post('/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res, next) => {
    try {
      if (!validate(req, res)) return;
      const { email, password } = req.body;
      const user = await User.findOne({ email }).select('+password');
      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json(formatResponse(false, 'Invalid email or password'));
      }
      if (!user.isActive) return res.status(403).json(formatResponse(false, 'Account deactivated'));
      user.lastLogin = new Date();
      await user.save({ validateBeforeSave: false });
      res.json(formatResponse(true, 'Login successful', { token: sign(user._id), user }));
    } catch (err) { next(err); }
  }
);

// GET /api/auth/me
router.get('/me', protect, (req, res) => res.json(formatResponse(true, 'OK', { user: req.user })));

// PATCH /api/auth/me
router.patch('/me', protect, async (req, res, next) => {
  try {
    const { name, password, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (name) user.name = name;
    if (newPassword) {
      if (!password || !(await user.comparePassword(password))) {
        return res.status(400).json(formatResponse(false, 'Current password incorrect'));
      }
      user.password = newPassword;
    }
    await user.save();
    res.json(formatResponse(true, 'Profile updated', { user }));
  } catch (err) { next(err); }
});

// POST /api/auth/regenerate-api-key
router.post('/regenerate-api-key', protect, async (req, res, next) => {
  try {
    const apiKey = `sk-wa-${uuidv4().replace(/-/g, '')}`;
    await User.findByIdAndUpdate(req.user._id, { apiKey });
    res.json(formatResponse(true, 'API key regenerated', { apiKey }));
  } catch (err) { next(err); }
});

module.exports = router;
