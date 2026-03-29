'use strict';
const { Contract } = require('../models');
const crypto = require('crypto');

/**
 * Generate unique contract number
 */
function generateContractNumber(userId) {
  const timestamp = Date.now().toString().slice(-8);
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CT-${timestamp}-${random}`;
}

/**
 * Create and send contract via WhatsApp
 */
async function createAndSendContract(userId, recipientPhone, recipientName, title, content, sock, jid) {
  try {
    const contractNumber = generateContractNumber(userId);
    
    const contract = new Contract({
      userId,
      title,
      content,
      recipientName,
      recipientPhone,
      contractNumber,
      status: 'sent',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    });
    
    await contract.save();
    
    // Generate accept link (you'll need your frontend URL)
    const frontendUrl = process.env.FRONTEND_URL || 'https://waflow-backend.onrender.com';
    const acceptLink = `${frontendUrl}/api/contracts/sign/${contractNumber}`;
    
    const contractMessage = `📄 *DIGITAL CONTRACT* 📄\n\n` +
      `*Contract #:* ${contractNumber}\n` +
      `*Title:* ${title}\n` +
      `*Valid Until:* ${new Date(contract.expiresAt).toLocaleDateString()}\n\n` +
      `---\n${content}\n---\n\n` +
      `*Recipient:* ${recipientName}\n` +
      `*Phone:* ${recipientPhone}\n\n` +
      `⚠️ *IMPORTANT:* This is a legally binding agreement.\n\n` +
      `✅ *To accept this contract, click the link below:*\n` +
      `${acceptLink}\n\n` +
      `_By clicking accept, you agree to the terms and conditions._`;
    
    await sock.sendMessage(jid, { text: contractMessage });
    
    console.log(`[Contract] Created and sent: ${contractNumber} to ${recipientPhone}`);
    return contract;
  } catch (err) {
    console.error('[Contract] Create error:', err);
    throw err;
  }
}

/**
 * Sign contract via webhook/link
 */
async function signContract(contractNumber, ip, userAgent) {
  try {
    const contract = await Contract.findOne({ contractNumber });
    
    if (!contract) {
      return { success: false, message: 'Contract not found' };
    }
    
    if (contract.status === 'signed') {
      return { success: false, message: 'Contract already signed' };
    }
    
    if (contract.status === 'rejected') {
      return { success: false, message: 'Contract was rejected' };
    }
    
    if (contract.expiresAt && contract.expiresAt < new Date()) {
      contract.status = 'expired';
      await contract.save();
      return { success: false, message: 'Contract has expired' };
    }
    
    contract.status = 'signed';
    contract.signedAt = new Date();
    contract.signatureData = {
      ipHash: crypto.createHash('sha256').update(ip || 'unknown').digest('hex'),
      userAgent: userAgent || 'unknown',
      timestamp: new Date()
    };
    
    await contract.save();
    
    console.log(`[Contract] Signed: ${contractNumber} by ${contract.recipientName}`);
    return { success: true, contract };
  } catch (err) {
    console.error('[Contract] Sign error:', err);
    return { success: false, message: err.message };
  }
}

/**
 * Get contract by number
 */
async function getContract(contractNumber) {
  return await Contract.findOne({ contractNumber });
}

/**
 * Get all contracts for a user
 */
async function getUserContracts(userId, status = null) {
  const query = { userId };
  if (status) query.status = status;
  return await Contract.find(query).sort({ createdAt: -1 });
}

module.exports = { 
  createAndSendContract, 
  signContract, 
  getContract, 
  getUserContracts,
  generateContractNumber 
};