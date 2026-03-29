'use strict';
const express = require('express');
const { protect } = require('../middleware/auth');
const { createAndSendContract, signContract, getUserContracts, getContract } = require('../services/contractService');
const { sessions } = require('../whatsapp/engine');
const { formatResponse } = require('../utils/response');
const router = express.Router();

/**
 * POST /api/contracts/create
 * Create and send contract via WhatsApp
 */
router.post('/create', protect, async (req, res, next) => {
  try {
    const { recipientPhone, recipientName, title, content } = req.body;
    const userId = req.user._id.toString();
    
    if (!recipientPhone || !recipientName || !title || !content) {
      return res.status(400).json(formatResponse(false, 'recipientPhone, recipientName, title, and content are required'));
    }
    
    const sock = sessions.get(userId);
    if (!sock) {
      return res.status(400).json(formatResponse(false, 'WhatsApp not connected'));
    }
    
    const jid = recipientPhone.replace('+', '') + '@s.whatsapp.net';
    
    const contract = await createAndSendContract(
      userId, recipientPhone, recipientName, title, content, sock, jid
    );
    
    res.json(formatResponse(true, 'Contract created and sent', { contract }));
  } catch (err) {
    console.error('[Contracts] Create error:', err);
    next(err);
  }
});

/**
 * GET /api/contracts/list
 * Get all contracts for the authenticated user
 */
router.get('/list', protect, async (req, res, next) => {
  try {
    const { status } = req.query;
    const contracts = await getUserContracts(req.user._id, status);
    res.json(formatResponse(true, 'OK', { contracts }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contracts/:contractNumber
 * Get specific contract by number
 */
router.get('/:contractNumber', protect, async (req, res, next) => {
  try {
    const contract = await getContract(req.params.contractNumber);
    if (!contract) {
      return res.status(404).json(formatResponse(false, 'Contract not found'));
    }
    if (contract.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json(formatResponse(false, 'Unauthorized'));
    }
    res.json(formatResponse(true, 'OK', { contract }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/contracts/sign/:contractNumber
 * PUBLIC endpoint - Sign contract (no authentication required)
 * This is the link sent to clients via WhatsApp
 */
router.post('/sign/:contractNumber', async (req, res) => {
  try {
    const { contractNumber } = req.params;
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const result = await signContract(contractNumber, ip, userAgent);
    
    if (result.success) {
      res.json(formatResponse(true, 'Contract signed successfully', { contract: result.contract }));
    } else {
      res.status(400).json(formatResponse(false, result.message));
    }
  } catch (err) {
    console.error('[Contracts] Sign error:', err);
    res.status(500).json(formatResponse(false, 'Error signing contract'));
  }
});

/**
 * GET /api/contracts/sign/:contractNumber
 * PUBLIC endpoint - Show contract signing page info
 */
router.get('/sign/:contractNumber', async (req, res) => {
  try {
    const contract = await getContract(req.params.contractNumber);
    if (!contract) {
      return res.status(404).json(formatResponse(false, 'Contract not found'));
    }
    
    if (contract.status === 'signed') {
      return res.json(formatResponse(true, 'Contract already signed', { contract, alreadySigned: true }));
    }
    
    if (contract.status === 'expired') {
      return res.json(formatResponse(false, 'Contract has expired', { contract, expired: true }));
    }
    
    res.json(formatResponse(true, 'Contract ready for signing', { 
      contract: {
        contractNumber: contract.contractNumber,
        title: contract.title,
        content: contract.content,
        recipientName: contract.recipientName,
        expiresAt: contract.expiresAt
      }
    }));
  } catch (err) {
    console.error('[Contracts] Get sign error:', err);
    res.status(500).json(formatResponse(false, 'Error loading contract'));
  }
});

module.exports = router;