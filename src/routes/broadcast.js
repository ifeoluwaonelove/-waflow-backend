'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { Contact, Broadcast, Message } = require('../models');
const { formatResponse } = require('../utils/response');
const router = express.Router();

// ============ ROOT ENDPOINT ============
/**
 * GET /api/broadcast
 * Root endpoint to check if broadcast API is working
 */
router.get('/', protect, async (req, res) => {
  res.json(formatResponse(true, 'Broadcast API is working', {
    endpoints: [
      'GET /contacts/filtered - Get filtered contacts with search and filters',
      'POST /contacts/selected - Get details of selected contacts',
      'POST /create-selective - Create a selective broadcast',
      'GET /stats/contacts - Get contact statistics'
    ],
    version: '1.0.0'
  }));
});

// ============ SELECTIVE BROADCASTING ROUTES ============

/**
 * GET /api/broadcast/contacts/filtered
 * Get contacts with filtering for selective broadcasting
 */
router.get('/contacts/filtered', protect, async (req, res, next) => {
  try {
    const { 
      search = '', 
      tags, 
      group, 
      recent, 
      page = 1, 
      limit = 50 
    } = req.query;
    const userId = req.user._id;
    
    let query = { 
      userId, 
      isActive: true 
    };
    
    // Search by name or phone
    if (search && search.trim()) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { displayName: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Filter by tags
    if (tags && tags !== 'all' && tags !== '') {
      const tagArray = tags.split(',').filter(t => t.trim());
      if (tagArray.length > 0) {
        query.tags = { $in: tagArray };
      }
    }
    
    // Filter by group
    if (group && group !== 'all' && group !== '') {
      query.group = group;
    }
    
    // Filter by recent chats
    if (recent && recent !== 'all' && recent !== '') {
      const days = parseInt(recent);
      if (!isNaN(days)) {
        const recentDate = new Date();
        recentDate.setDate(recentDate.getDate() - days);
        query.lastMessageAt = { $gte: recentDate };
      }
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const pageLimit = parseInt(limit);
    
    const [contacts, total] = await Promise.all([
      Contact.find(query)
        .select('name phone displayName tags group lastMessageAt createdAt')
        .skip(skip)
        .limit(pageLimit)
        .sort({ lastMessageAt: -1, createdAt: -1 }),
      Contact.countDocuments(query)
    ]);
    
    // Get available tags for filtering
    const availableTags = await Contact.distinct('tags', { 
      userId, 
      isActive: true,
      tags: { $ne: [] } 
    });
    
    // Get available groups for filtering
    const availableGroups = await Contact.distinct('group', { 
      userId, 
      isActive: true 
    });
    
    res.json(formatResponse(true, 'OK', {
      contacts,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / pageLimit),
      availableTags: availableTags.filter(t => t && t !== ''),
      availableGroups: availableGroups.filter(g => g && g !== '')
    }));
  } catch (err) {
    console.error('[Selective Broadcast] Filtered contacts error:', err);
    next(err);
  }
});

/**
 * POST /api/broadcast/contacts/selected
 * Get selected contacts by IDs
 */
router.post('/contacts/selected', protect, async (req, res, next) => {
  try {
    const { contactIds } = req.body;
    const userId = req.user._id;
    
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json(formatResponse(false, 'No contact IDs provided'));
    }
    
    const contacts = await Contact.find({
      _id: { $in: contactIds },
      userId,
      isActive: true
    }).select('name phone displayName tags group');
    
    res.json(formatResponse(true, 'OK', { contacts }));
  } catch (err) {
    console.error('[Selective Broadcast] Selected contacts error:', err);
    next(err);
  }
});

/**
 * POST /api/broadcast/create-selective
 * Create a selective broadcast with chosen contacts
 */
router.post('/create-selective', protect, async (req, res, next) => {
  try {
    const { 
      title, 
      messages, 
      contactIds, 
      delayBetweenMessages = 2000,
      scheduledAt = null 
    } = req.body;
    const userId = req.user._id;
    
    // Validate required fields
    if (!title) {
      return res.status(400).json(formatResponse(false, 'Broadcast title is required'));
    }
    
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json(formatResponse(false, 'At least one message is required'));
    }
    
    if (!contactIds || !Array.isArray(contactIds) || contactIds.length === 0) {
      return res.status(400).json(formatResponse(false, 'No contacts selected'));
    }
    
    // Verify all contacts belong to user and are active
    const contacts = await Contact.find({
      _id: { $in: contactIds },
      userId,
      isActive: true
    });
    
    if (contacts.length !== contactIds.length) {
      const foundIds = contacts.map(c => c._id.toString());
      const missingIds = contactIds.filter(id => !foundIds.includes(id));
      return res.status(400).json(formatResponse(false, `Invalid contacts: ${missingIds.join(', ')}`));
    }
    
    // Create broadcast
    const broadcast = new Broadcast({
      userId,
      title,
      messages,
      targetType: 'custom',
      targetContacts: contactIds,
      totalRecipients: contacts.length,
      delayBetweenMessages,
      scheduledAt: scheduledAt || null,
      status: scheduledAt ? 'scheduled' : 'draft'
    });
    
    await broadcast.save();
    
    // If not scheduled, start immediately
    if (!scheduledAt) {
      // Trigger broadcast processing
      const { processBroadcast } = require('../services/broadcastService');
      processBroadcast(broadcast._id).catch(err => {
        console.error('[Selective Broadcast] Processing error:', err);
      });
    }
    
    res.json(formatResponse(true, 'Broadcast created successfully', { 
      broadcast: {
        id: broadcast._id,
        title: broadcast.title,
        recipients: contacts.length,
        status: broadcast.status,
        scheduledAt: broadcast.scheduledAt
      }
    }));
  } catch (err) {
    console.error('[Selective Broadcast] Create error:', err);
    next(err);
  }
});

/**
 * GET /api/broadcast/stats/contacts
 * Get contact statistics for dashboard
 */
router.get('/stats/contacts', protect, async (req, res, next) => {
  try {
    const userId = req.user._id;
    
    const [
      totalContacts,
      activeContacts,
      tagsList,
      groupsList,
      recentActive
    ] = await Promise.all([
      Contact.countDocuments({ userId, isActive: true }),
      Contact.countDocuments({ userId, isActive: true, lastMessageAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      Contact.distinct('tags', { userId, isActive: true, tags: { $ne: [] } }),
      Contact.distinct('group', { userId, isActive: true }),
      Contact.countDocuments({ 
        userId, 
        isActive: true, 
        lastMessageAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } 
      })
    ]);
    
    res.json(formatResponse(true, 'OK', {
      totalContacts,
      activeContacts,
      recentActive,
      totalTags: tagsList.filter(t => t && t !== '').length,
      totalGroups: groupsList.filter(g => g && g !== '').length
    }));
  } catch (err) {
    console.error('[Selective Broadcast] Stats error:', err);
    next(err);
  }
});

module.exports = router;
/**
 * POST /api/broadcast/group
 * Send broadcast to group with @all mention (admin only)
 */
router.post('/group', protect, async (req, res, next) => {
  try {
    const { groupId, message, tagAll = false } = req.body;
    const userId = req.user._id;
    
    if (!groupId) {
      return res.status(400).json(formatResponse(false, 'Group ID is required'));
    }
    
    if (!message || !message.trim()) {
      return res.status(400).json(formatResponse(false, 'Message is required'));
    }
    
    // Get user's WhatsApp connection
    const user = await User.findById(userId);
    if (!user.whatsappConnected) {
      return res.status(400).json(formatResponse(false, 'WhatsApp not connected. Please connect WhatsApp first.'));
    }
    
    // Check rate limit for group broadcasts (1 per hour)
    const lastGroupBroadcast = await Broadcast.findOne({
      userId,
      targetGroup: groupId,
      status: 'sent',
      sentAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } // Last hour
    });
    
    if (lastGroupBroadcast && tagAll) {
      return res.status(429).json(formatResponse(false, 'Rate limit: Only 1 group @all broadcast per hour. Please wait before sending another.'));
    }
    
    // Get sock instance from whatsapp engine
    const { sessions } = require('../whatsapp/engine');
    const sock = sessions.get(userId.toString());
    
    if (!sock) {
      return res.status(400).json(formatResponse(false, 'WhatsApp session not active. Please reconnect WhatsApp.'));
    }
    
    // Get group metadata from WhatsApp
    let groupMetadata;
    try {
      groupMetadata = await sock.groupMetadata(groupId);
    } catch (err) {
      console.error('[Group Broadcast] Failed to get group metadata:', err);
      return res.status(400).json(formatResponse(false, 'Failed to get group information. Make sure you are still a member of this group.'));
    }
    
    // Check if user is admin (only required for @all mentions)
    const isAdmin = groupMetadata.participants.some(p => 
      p.id === sock.user.id && (p.admin === 'admin' || p.admin === 'superadmin')
    );
    
    if (tagAll && !isAdmin) {
      return res.status(403).json(formatResponse(false, 'Only group admins can use @all mentions. You need to be a group admin to tag all members.'));
    }
    
    // Prepare mentions array
    let mentions = [];
    if (tagAll) {
      // Get all participant JIDs except the sender
      mentions = groupMetadata.participants
        .filter(p => p.id !== sock.user.id)
        .map(p => p.id);
      
      // Limit mentions to 100 to avoid rate limiting issues
      if (mentions.length > 100) {
        return res.status(400).json(formatResponse(false, `Group has ${mentions.length} members. @all mentions limited to 100 members to prevent spam.`));
      }
    }
    
    // Send message with mentions
    let sentMessage;
    try {
      if (tagAll && mentions.length > 0) {
        sentMessage = await sock.sendMessage(groupId, {
          text: message,
          mentions: mentions
        });
      } else {
        sentMessage = await sock.sendMessage(groupId, {
          text: message
        });
      }
    } catch (err) {
      console.error('[Group Broadcast] Failed to send message:', err);
      return res.status(500).json(formatResponse(false, 'Failed to send message: ' + err.message));
    }
    
    // Save broadcast record
    const broadcast = new Broadcast({
      userId,
      title: `Group broadcast to ${groupMetadata.subject}`,
      messages: [{ text: message }],
      targetType: 'group',
      targetGroup: groupId,
      totalRecipients: tagAll ? mentions.length : 1,
      status: 'sent',
      sentAt: new Date(),
      delivered: tagAll ? mentions.length : 1,
      failed: 0
    });
    
    await broadcast.save();
    
    res.json(formatResponse(true, 'Group broadcast sent successfully', {
      groupName: groupMetadata.subject,
      recipients: tagAll ? mentions.length : 1,
      tagAllUsed: tagAll,
      broadcastId: broadcast._id,
      message: tagAll ? `Message sent to ${mentions.length} members with @all mention` : 'Message sent to group'
    }));
    
  } catch (err) {
    console.error('[Group Broadcast] Error:', err);
    next(err);
  }
});

/**
 * GET /api/broadcast/groups
 * Get all WhatsApp groups the user is in
 */
router.get('/groups', protect, async (req, res, next) => {
  try {
    const userId = req.user._id;
    
    // Get sock instance
    const { sessions } = require('../whatsapp/engine');
    const sock = sessions.get(userId.toString());
    
    if (!sock) {
      return res.status(400).json(formatResponse(false, 'WhatsApp not connected'));
    }
    
    // Get all chats
    const chats = await sock.groupFetchAllParticipating();
    const groups = Object.values(chats).map(group => ({
      id: group.id,
      name: group.subject,
      participantCount: group.participants?.length || 0,
      isAdmin: group.participants?.some(p => p.id === sock.user.id && (p.admin === 'admin' || p.admin === 'superadmin')) || false
    }));
    
    res.json(formatResponse(true, 'OK', { groups }));
  } catch (err) {
    console.error('[Group Broadcast] Failed to fetch groups:', err);
    res.status(500).json(formatResponse(false, 'Failed to fetch groups: ' + err.message));
  }
});