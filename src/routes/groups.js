'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { GroupMember, Contact } = require('../models');
const { sessions } = require('../whatsapp/engine');
const { formatResponse } = require('../utils/response');
const router = express.Router();

// GET /api/groups — list all joined groups from Baileys
router.get('/', protect, async (req, res, next) => {
  try {
    const sock = sessions.get(req.user._id.toString());
    if (!sock) return res.status(400).json(formatResponse(false, 'WhatsApp not connected'));

    // Baileys stores group metadata on the socket
    const groups = [];
    try {
      const allChats = await sock.groupFetchAllParticipating();
      for (const [jid, meta] of Object.entries(allChats)) {
        groups.push({
          jid,
          name:       meta.subject || jid,
          size:       meta.participants?.length || 0,
          createdAt:  meta.creation ? new Date(meta.creation * 1000) : null,
        });
      }
    } catch (e) {
      console.error('[Groups] fetchAllParticipating error:', e.message);
    }

    res.json(formatResponse(true, 'OK', { groups }));
  } catch (err) { next(err); }
});

// POST /api/groups/:jid/extract — extract members of a group
router.post('/:jid/extract', protect, async (req, res, next) => {
  try {
    const sock = sessions.get(req.user._id.toString());
    if (!sock) return res.status(400).json(formatResponse(false, 'WhatsApp not connected'));

    const { jid } = req.params;
    let meta;
    try {
      meta = await sock.groupMetadata(jid);
    } catch (e) {
      return res.status(400).json(formatResponse(false, 'Could not fetch group: ' + e.message));
    }

    const members = meta.participants || [];
    const results = [];

    for (const p of members) {
      const phone = '+' + p.id.replace('@s.whatsapp.net', '').replace('@c.us', '');
      const name  = p.notify || null;

      // Upsert into GroupMember collection
      await GroupMember.findOneAndUpdate(
        { userId: req.user._id, groupJid: jid, phone },
        { userId: req.user._id, groupJid: jid, groupName: meta.subject, phone, name, extractedAt: new Date() },
        { upsert: true, new: true }
      );

      results.push({ phone, name, role: p.admin || 'member' });
    }

    res.json(formatResponse(true, `Extracted ${results.length} members`, {
      groupName: meta.subject,
      members: results,
    }));
  } catch (err) { next(err); }
});

// GET /api/groups/members — get all extracted members
router.get('/members', protect, async (req, res, next) => {
  try {
    const { groupJid, page = 1, limit = 100 } = req.query;
    const query = { userId: req.user._id };
    if (groupJid) query.groupJid = groupJid;
    const total   = await GroupMember.countDocuments(query);
    const members = await GroupMember.find(query).sort({ groupName: 1, name: 1 }).skip((page - 1) * limit).limit(parseInt(limit));
    res.json({ success: true, total, data: members });
  } catch (err) { next(err); }
});

// POST /api/groups/members/save-contacts — save extracted members as contacts
router.post('/members/save-contacts', protect, async (req, res, next) => {
  try {
    const { memberIds } = req.body; // array of GroupMember _ids
    if (!memberIds?.length) return res.status(400).json(formatResponse(false, 'memberIds required'));

    const members = await GroupMember.find({ _id: { $in: memberIds }, userId: req.user._id });
    let saved = 0, skipped = 0;

    for (const m of members) {
      const exists = await Contact.findOne({ userId: req.user._id, phone: m.phone });
      if (exists) { skipped++; continue; }

      await Contact.create({
        userId:        req.user._id,
        phone:         m.phone,
        name:          m.name,
        displayName:   m.name || m.phone,
        group:         'Group Contacts',
        tags:          ['extracted', m.groupName].filter(Boolean),
        firstMessageAt: new Date(),
      });
      saved++;
    }

    res.json(formatResponse(true, `${saved} contacts saved, ${skipped} already existed`));
  } catch (err) { next(err); }
});

// GET /api/groups/members/export — CSV export
router.get('/members/export', protect, async (req, res, next) => {
  try {
    const { groupJid } = req.query;
    const query = { userId: req.user._id };
    if (groupJid) query.groupJid = groupJid;
    const members = await GroupMember.find(query).sort({ groupName: 1 });

    const header = 'Name,Phone,Group,Extracted At\n';
    const rows   = members.map(m => `"${m.name||''}","${m.phone}","${m.groupName||''}","${m.extractedAt.toISOString()}"`).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=group-members.csv');
    res.send(header + rows);
  } catch (err) { next(err); }
});

/**
 * GET /api/groups/:jid/members/all
 * Get ALL group members (bypasses Baileys 100-member cache limit)
 * This forces a fresh fetch from WhatsApp instead of using cached data
 */
router.get('/:jid/members/all', protect, async (req, res, next) => {
  try {
    const sock = sessions.get(req.user._id.toString());
    if (!sock) {
      return res.status(400).json(formatResponse(false, 'WhatsApp not connected'));
    }

    const { jid } = req.params;
    
    // Force fetch fresh group metadata (NOT from cache)
    let meta;
    try {
      meta = await sock.groupMetadata(jid);
    } catch (e) {
      return res.status(400).json(formatResponse(false, 'Could not fetch group: ' + e.message));
    }

    // Extract ALL participants (no 100 limit like the cached version)
    const allMembers = (meta.participants || []).map(p => ({
      id: p.id,
      name: p.notify || p.name || null,
      phone: '+' + p.id.replace('@s.whatsapp.net', '').replace('@c.us', ''),
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin'
    }));
    
    console.log(`[Group Extract] Extracted ALL ${allMembers.length} members from ${meta.subject}`);
    
    res.json(formatResponse(true, 'OK', {
      groupName: meta.subject,
      totalMembers: allMembers.length,
      members: allMembers
    }));
  } catch (err) { 
    console.error('[Groups API] Get all members error:', err);
    next(err); 
  }
});

module.exports = router;
