'use strict';
const { Transaction } = require('../models');

/**
 * Create expense from WhatsApp message
 * Format: "expense 5000 for Facebook Ads" or "expense 2000 Transport"
 */
async function createExpenseFromMessage(userId, phone, amount, description) {
  try {
    // Detect category from description
    let category = 'general';
    const lowerDesc = description.toLowerCase();
    
    if (lowerDesc.includes('ads') || lowerDesc.includes('advert') || lowerDesc.includes('facebook') || lowerDesc.includes('google')) {
      category = 'marketing';
    } else if (lowerDesc.includes('transport') || lowerDesc.includes('fuel') || lowerDesc.includes('uber')) {
      category = 'transport';
    } else if (lowerDesc.includes('equipment') || lowerDesc.includes('device') || lowerDesc.includes('laptop')) {
      category = 'equipment';
    } else if (lowerDesc.includes('rent') || lowerDesc.includes('office')) {
      category = 'rent';
    } else if (lowerDesc.includes('salary') || lowerDesc.includes('wage') || lowerDesc.includes('staff')) {
      category = 'salary';
    } else if (lowerDesc.includes('software') || lowerDesc.includes('subscription') || lowerDesc.includes('tool')) {
      category = 'software';
    } else if (lowerDesc.includes('food') || lowerDesc.includes('lunch')) {
      category = 'food';
    }
    
    const transaction = new Transaction({
      userId,
      type: 'expense',
      amount: amount,
      description: description,
      category: category,
      date: new Date(),
      reference: `EXP-${Date.now().toString().slice(-8)}`
    });
    
    await transaction.save();
    
    console.log(`[Expense] Created: ₦${amount} - ${description} (${category}) for user ${userId}`);
    return transaction;
  } catch (err) {
    console.error('[Expense] Create error:', err);
    return null;
  }
}

/**
 * Get expense summary for user
 */
async function getExpenseSummary(userId, days = 30) {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const expenses = await Transaction.find({
      userId,
      type: 'expense',
      date: { $gte: startDate }
    });
    
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    const byCategory = {};
    
    expenses.forEach(e => {
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    });
    
    return {
      total,
      count: expenses.length,
      byCategory,
      average: expenses.length > 0 ? total / expenses.length : 0,
      days
    };
  } catch (err) {
    console.error('[Expense] Summary error:', err);
    return null;
  }
}

module.exports = { createExpenseFromMessage, getExpenseSummary };