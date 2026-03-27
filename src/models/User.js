const mongoose = require('mongoose');
// This ensures we check the central index where all schemas are defined
const models = require('./index');
module.exports = models.User;