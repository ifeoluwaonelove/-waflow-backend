const mongoose = require('mongoose');
module.exports = mongoose.models.Contact || mongoose.model('Contact');
