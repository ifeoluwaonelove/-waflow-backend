'use strict';
const cron = require('node-cron');
const { cleanupBroadcastMessages } = require('../jobs/cleanupBroadcasts');

/**
 * Start the scheduled cleanup job
 * Runs daily at 2 AM to clean up old broadcast data
 */
function startCleanupScheduler() {
  // Schedule to run every day at 2:00 AM
  // cron format: minute hour day-of-month month day-of-week
  cron.schedule('0 2 * * *', async () => {
    console.log('[Cleanup Scheduler] Running scheduled cleanup at', new Date().toISOString());
    
    try {
      const result = await cleanupBroadcastMessages();
      console.log('[Cleanup Scheduler] Cleanup completed:', result);
    } catch (err) {
      console.error('[Cleanup Scheduler] Cleanup failed:', err);
    }
  });
  
  console.log('[Cleanup Scheduler] Scheduled to run daily at 2:00 AM');
  
  // Optional: Run once on startup to clean any missed broadcasts
  setTimeout(async () => {
    console.log('[Cleanup Scheduler] Running initial cleanup on startup...');
    await cleanupBroadcastMessages();
  }, 60000); // Run 1 minute after startup
}

module.exports = { startCleanupScheduler };