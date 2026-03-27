'use strict';
const { formatResponse } = require('../utils/response');

const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json(formatResponse(false, 'Admin access required'));
  }
  next();
};

module.exports = { adminOnly };
