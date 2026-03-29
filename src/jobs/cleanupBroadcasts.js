'use strict';
const { Message, Broadcast } = require('../models');

/**
 * Clean up old broadcast messages to save storage
 * Deletes message body and media references after 7 days
 */
async function cleanupBroadcastMessages() {
  try {
    console.log('[Cleanup] Starting broadcast message cleanup...');
    
    // Find broadcasts older than 7 days that are completed
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const oldBroadcasts = await Broadcast.find({
      status: 'sent',
      sentAt: { $lt: sevenDaysAgo }
    }).select('_id');
    
    const broadcastIds = oldBroadcasts.map(b => b._id);
    
    if (broadcastIds.length === 0) {
      console.log('[Cleanup] No old broadcasts found to clean up');
      return { cleaned: 0, message: 'No old broadcasts found' };
    }
    
    // Update messages - remove heavy data but keep essential info
    const result = await Message.updateMany(
      { 
        broadcastId: { $in: broadcastIds },
        isDeleted: false
      },
      {
        $unset: {
          body: '',           // Remove message body
          mediaUrl: '',       // Remove media URL
          deletedBody: ''     // Remove deleted body if exists
        },
        $set: {
          isDeleted: true,    // Mark as cleaned
          cleanedAt: new Date() // Track when cleaned
        }
      }
    );
    
    console.log(`[Cleanup] Cleaned up ${result.modifiedCount} old broadcast messages`);
    
    // Also clean up old sessions (30+ days inactive)
    const { Session } = require('../models');
    if (Session) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const sessionResult = await Session.updateMany(
        { 
          lastUsed: { $lt: thirtyDaysAgo },
          status: 'active'
        },
        { status: 'expired' }
      );
      
      console.log(`[Cleanup] Expired ${sessionResult.modifiedCount} old sessions`);
    }
    
    return { 
      cleaned: result.modifiedCount, 
      sessionsExpired: sessionResult?.modifiedCount || 0,
      message: `Cleaned ${result.modifiedCount} messages and expired ${sessionResult?.modifiedCount || 0} sessions`
    };
    
  } catch (err) {
    console.error('[Cleanup] Error:', err);
    return { cleaned: 0, error: err.message };
  }
}

/**
 * Clean up specific broadcast by ID (call after broadcast completes)
 */
async function cleanupSingleBroadcast(broadcastId) {
  try {
    const result = await Message.updateMany(
      { 
        broadcastId: broadcastId,
        isDeleted: false
      },
      {
        $unset: { body: '', mediaUrl: '' },
        $set: { isDeleted: true, cleanedAt: new Date() }
      }
    );
    
    console.log(`[Cleanup] Cleaned broadcast ${broadcastId}: ${result.modifiedCount} messages`);
    return result.modifiedCount;
  } catch (err) {
    console.error(`[Cleanup] Error cleaning broadcast ${broadcastId}:`, err);
    return 0;
  }
}

module.exports = { cleanupBroadcastMessages, cleanupSingleBroadcast };