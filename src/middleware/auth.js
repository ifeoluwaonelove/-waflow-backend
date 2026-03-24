'use strict';
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { formatResponse } = require('../utils/response');

const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // API key auth
    if (!token && req.headers['x-api-key']) {
      const user = await User.findOne({ apiKey: req.headers['x-api-key'], isActive: true });
      if (!user) return res.status(401).json(formatResponse(false, 'Invalid API key'));
      req.user = user;
      return next();
    }

    if (!token) return res.status(401).json(formatResponse(false, 'Not authenticated'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive) return res.status(401).json(formatResponse(false, 'User not found'));

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json(formatResponse(false, 'Invalid token'));
    if (err.name === 'TokenExpiredError') return res.status(401).json(formatResponse(false, 'Token expired'));
    next(err);
  }
};

const requirePlan = (...plans) => (req, res, next) => {
  if (!plans.includes(req.user.plan)) {
    return res.status(403).json(formatResponse(false, `Upgrade required. This feature needs: ${plans.join(' or ')} plan.`));
  }
  next();
};

module.exports = { protect, requirePlan };
