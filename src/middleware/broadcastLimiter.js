'use strict';
const rateLimit = require('express-rate-limit');

// Rate limiter for selective broadcasts
const selectiveBroadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 broadcasts per hour
  keyGenerator: (req) => req.user._id.toString(),
  message: 'Too many broadcasts created. Please wait an hour.'
});

// Rate limiter for group @all feature
const groupTagAllLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1, // 1 group @all per hour
  keyGenerator: (req) => `${req.user._id}-${req.body.groupId}`,
  message: 'Too many group @all broadcasts. Please wait an hour.'
});

module.exports = { selectiveBroadcastLimiter, groupTagAllLimiter };
const groupBroadcastLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1,
  keyGenerator: (req) => `${req.user._id}-${req.body.groupId}`,
  message: 'Too many group broadcasts. Please wait an hour before sending another @all broadcast.'
});