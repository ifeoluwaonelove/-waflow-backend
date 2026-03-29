'use strict';
const { cleanupSingleBroadcast } = require('../jobs/cleanupBroadcasts');
const { Broadcast, Contact, Message } = require('../models');
const { sendMessage } = require('../whatsapp/engine');

/**
 * Process a broadcast (selective or otherwise)
 */
async function processBroadcast(broadcastId) {
  try {
    const broadcast = await Broadcast.findById(broadcastId);
    if (!broadcast) {
      console.error(`[Broadcast] Not found: ${broadcastId}`);
      return;
    }
    
    // Check if already processing or sent
    if (broadcast.status === 'sending' || broadcast.status === 'sent') {
      console.log(`[Broadcast] Already ${broadcast.status}: ${broadcastId}`);
      return;
    }
    
    // Update status to sending
    broadcast.status = 'sending';
    await broadcast.save();
    
    // Get recipients based on target type
    let recipients = [];
    
    if (broadcast.targetType === 'custom' && broadcast.targetContacts.length > 0) {
      // Selective broadcast with specific contacts
      recipients = await Contact.find({
        _id: { $in: broadcast.targetContacts },
        userId: broadcast.userId,
        isActive: true
      });
    } else if (broadcast.targetType === 'all') {
      // Broadcast to all contacts
      recipients = await Contact.find({
        userId: broadcast.userId,
        isActive: true
      });
    } else if (broadcast.targetType === 'group') {
      // Broadcast to a specific group
      recipients = await Contact.find({
        userId: broadcast.userId,
        group: broadcast.targetGroup,
        isActive: true
      });
    } else if (broadcast.targetType === 'tags') {
      // Broadcast to contacts with specific tags
      recipients = await Contact.find({
        userId: broadcast.userId,
        tags: { $in: broadcast.targetTags },
        isActive: true
      });
    }
    
    broadcast.totalRecipients = recipients.length;
    await broadcast.save();
    
    let delivered = 0;
    let failed = 0;
    
    // Send messages to each recipient
    for (const contact of recipients) {
      try {
        // Get the message to send
        let messageToSend = broadcast.messages[0];
        if (broadcast.messages.length > 1 && broadcast.rotationMode === 'random') {
          const randomIndex = Math.floor(Math.random() * broadcast.messages.length);
          messageToSend = broadcast.messages[randomIndex];
        }
        
        // Send the message
        await sendMessage(
          broadcast.userId.toString(),
          contact.phone,
          messageToSend.text,
          messageToSend.mediaUrl,
          messageToSend.mediaType
        );
        
        // Log the message
        await Message.create({
          userId: broadcast.userId,
          contactId: contact._id,
          phone: contact.phone,
          direction: 'outbound',
          body: messageToSend.text,
          broadcastId: broadcast._id,
          status: 'sent',
          timestamp: new Date()
        });
        
        delivered++;
        
        // Update contact's last message timestamp
        await Contact.findByIdAndUpdate(contact._id, {
          lastMessageAt: new Date(),
          $inc: { totalMessages: 1 }
        });
        
        // Delay between messages
        await new Promise(resolve => setTimeout(resolve, broadcast.delayBetweenMessages || 2000));
        
      } catch (err) {
        console.error(`[Broadcast] Failed to send to ${contact.phone}:`, err.message);
        failed++;
        
        // Log failed message
        await Message.create({
          userId: broadcast.userId,
          contactId: contact._id,
          phone: contact.phone,
          direction: 'outbound',
          body: messageToSend?.text || '',
          broadcastId: broadcast._id,
          status: 'failed',
          timestamp: new Date()
        });
      }
    }
    
    // Update broadcast with results
    broadcast.delivered = delivered;
    broadcast.failed = failed;
    broadcast.status = 'sent';
    broadcast.sentAt = new Date();
    await broadcast.save();
    
    console.log(`[Broadcast] Completed: ${broadcastId} - Sent to ${delivered}/${recipients.length}`);
    
    return { delivered, failed, total: recipients.length };
    
  } catch (err) {
    console.error('[Broadcast] Processing error:', err);
    
    // Update broadcast as failed
    await Broadcast.findByIdAndUpdate(broadcastId, {
      status: 'failed'
    });
    
    throw err;
  }
}

module.exports = { processBroadcast };
    // After successful broadcast, schedule cleanup (optional immediate or delayed)
    if (broadcast.status === 'sent') {
      // Clean up after 1 hour (give time for any processing)
      setTimeout(async () => {
        try {
          await cleanupSingleBroadcast(broadcastId);
          console.log(`[Broadcast] Auto-cleaned broadcast ${broadcastId}`);
        } catch (err) {
          console.error(`[Broadcast] Auto-cleanup failed for ${broadcastId}:`, err);
        }
      }, 60 * 60 * 1000); // 1 hour delay
    }