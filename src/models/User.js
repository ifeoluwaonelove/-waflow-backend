const mongoose = require('mongoose');
// We export the model already defined in index.js to prevent redeclaration
module.exports = mongoose.models.User || mongoose.model('User');
