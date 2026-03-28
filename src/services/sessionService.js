'use strict';
const Session = require('../models/Session');

/**
 * Save or update session - prevents duplicates by using upsert
 * @param {string} userId - User ID
 * @param {string} whatsappNumber - WhatsApp phone number
 * @param {object} sessionData - Session credentials/data
 * @param {object} deviceInfo - Optional device information
 * @returns {Promise<object>} Saved session
 */
async function saveSession(userId, whatsappNumber, sessionData, deviceInfo = {}) {
  try {
    // Use upsert to either update existing or create new
    const session = await Session.findOneAndUpdate(
      { userId, whatsappNumber },
      {
        userId,
        whatsappNumber,
        sessionData,
        status: 'active',
        lastUsed: new Date(),
        $setOnInsert: { deviceInfo }, // Only set on insert
        ...(deviceInfo && Object.keys(deviceInfo).length > 0 ? { deviceInfo } : {})
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    );
    
    console.log(`[Session] ${session.wasNew ? 'Created' : 'Updated'} session for ${whatsappNumber} (User: ${userId})`);
    return session;
  } catch (err) {
    // Handle duplicate key error gracefully
    if (err.code === 11000) {
      console.log(`[Session] Duplicate detected, fetching existing session for ${whatsappNumber}`);
      return await getSession(userId, whatsappNumber);
    }
    console.error('[Session] Save error:', err);
    throw err;
  }
}

/**
 * Get active session for a user
 * @param {string} userId - User ID
 * @param {string} whatsappNumber - WhatsApp phone number
 * @returns {Promise<object|null>} Session or null
 */
async function getSession(userId, whatsappNumber) {
  try {
    const session = await Session.findOne({ 
      userId, 
      whatsappNumber,
      status: 'active' 
    }).lean();
    
    if (session) {
      // Update lastUsed without waiting for response
      Session.updateOne(
        { _id: session._id },
        { lastUsed: new Date() }
      ).catch(err => console.error('[Session] Update lastUsed error:', err.message));
    }
    
    return session;
  } catch (err) {
    console.error('[Session] Get error:', err);
    return null;
  }
}

/**
 * Get all active sessions for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} List of sessions
 */
async function getUserSessions(userId) {
  try {
    return await Session.find({ 
      userId, 
      status: 'active' 
    }).sort({ lastUsed: -1 });
  } catch (err) {
    console.error('[Session] Get user sessions error:', err);
    return [];
  }
}

/**
 * Revoke/expire a session
 * @param {string} userId - User ID
 * @param {string} whatsappNumber - WhatsApp phone number
 * @param {string} reason - Reason for revocation
 */
async function revokeSession(userId, whatsappNumber, reason = 'manual') {
  try {
    const result = await Session.updateOne(
      { userId, whatsappNumber },
      { 
        status: 'revoked',
        lastUsed: new Date()
      }
    );
    
    if (result.modifiedCount > 0) {
      console.log(`[Session] Revoked session for ${whatsappNumber} (User: ${userId}) - Reason: ${reason}`);
    }
    
    return result;
  } catch (err) {
    console.error('[Session] Revoke error:', err);
    throw err;
  }
}

/**
 * Clean up expired sessions (older than specified days)
 * @param {number} daysOld - Age in days to consider expired
 * @returns {Promise<number>} Number of sessions expired
 */
async function cleanupExpiredSessions(daysOld = 30) {
  try {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() - daysOld);
    
    const result = await Session.updateMany(
      { 
        lastUsed: { $lt: expiryDate },
        status: 'active'
      },
      { status: 'expired' }
    );
    
    console.log(`[Session] Expired ${result.modifiedCount} old sessions`);
    return result.modifiedCount;
  } catch (err) {
    console.error('[Session] Cleanup error:', err);
    return 0;
  }
}

module.exports = {
  saveSession,
  getSession,
  getUserSessions,
  revokeSession,
  cleanupExpiredSessions
};