'use strict';

const formatResponse = (success, message, data = null) => {
  const res = { success, message };
  if (data !== null) res.data = data;
  return res;
};

const paginate = (data, total, page, limit) => ({
  success: true,
  data,
  pagination: {
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    pages: Math.ceil(total / limit),
  },
});

module.exports = { formatResponse, paginate };
