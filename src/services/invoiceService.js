'use strict';
const { Invoice, Transaction, Contact } = require('../models');

/**
 * Generate invoice from WhatsApp message
 * Example: "Pay 5000 for Web Design"
 */
async function generateInvoiceFromMessage(userId, phone, message) {
  try {
    // Parse message: "Pay [amount] for [description]"
    const payMatch = message.match(/pay\s+(\d+(?:\.\d+)?)\s+for\s+(.+)/i);
    if (!payMatch) return null;
    
    const amount = parseFloat(payMatch[1]);
    const description = payMatch[2].trim();
    
    // Find or create contact
    let contact = await Contact.findOne({ userId, phone });
    if (!contact) {
      contact = await Contact.create({
        userId,
        phone,
        name: phone,
        displayName: phone
      });
    }
    
    // Generate unique invoice number
    const invoiceCount = await Invoice.countDocuments({ userId });
    const invoiceNumber = `INV-${Date.now().toString().slice(-8)}-${invoiceCount + 1}`;
    
    // Create invoice
    const invoice = new Invoice({
      userId,
      invoiceNumber,
      clientName: contact.displayName || contact.name || phone,
      clientPhone: phone,
      items: [{ description, quantity: 1, unitPrice: amount, total: amount }],
      subtotal: amount,
      total: amount,
      status: 'sent',
      paymentStatus: 'pending',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days due
      notes: `Auto-generated from WhatsApp: ${message}`
    });
    
    await invoice.save();
    
    console.log(`[Invoice] Generated invoice ${invoiceNumber} for ₦${amount} from ${phone}`);
    return invoice;
  } catch (err) {
    console.error('[Invoice Service] Generate error:', err);
    return null;
  }
}

/**
 * Process payment and update invoice
 */
async function processPayment(invoiceNumber, amount, method = 'bank_transfer', reference = null) {
  try {
    const invoice = await Invoice.findOne({ invoiceNumber });
    
    if (!invoice) {
      return { success: false, message: 'Invoice not found' };
    }
    
    if (invoice.paymentStatus === 'paid') {
      return { success: false, message: 'Invoice already paid' };
    }
    
    // Update invoice
    invoice.paymentStatus = 'paid';
    invoice.status = 'paid';
    invoice.paidAt = new Date();
    invoice.paymentDate = new Date();
    invoice.paymentMethod = method;
    invoice.paymentReference = reference || `PAY-${Date.now()}`;
    await invoice.save();
    
    // Create income transaction
    const transaction = new Transaction({
      userId: invoice.userId,
      type: 'income',
      amount: invoice.total,
      description: `Payment for invoice ${invoice.invoiceNumber} - ${invoice.items[0]?.description || 'Service'}`,
      category: 'invoice_payment',
      date: new Date(),
      invoiceId: invoice._id,
      reference: invoice.paymentReference
    });
    await transaction.save();
    
    console.log(`[Payment] Processed payment for invoice ${invoiceNumber}: ₦${amount}`);
    
    return { 
      success: true, 
      invoice, 
      transaction
    };
  } catch (err) {
    console.error('[Payment] Error:', err);
    return { success: false, message: err.message };
  }
}

/**
 * Generate receipt message for WhatsApp
 */
function generateReceiptMessage(invoice) {
  return `✅ *PAYMENT CONFIRMATION* ✅\n\n` +
         `Dear ${invoice.clientName},\n\n` +
         `We have received your payment of *₦${invoice.total.toLocaleString()}* for:\n` +
         `${invoice.items.map(i => `• ${i.description}`).join('\n')}\n\n` +
         `📄 *Receipt Number:* ${invoice.invoiceNumber}\n` +
         `📅 *Payment Date:* ${new Date().toLocaleDateString()}\n` +
         `💳 *Payment Method:* ${invoice.paymentMethod || 'Bank Transfer'}\n\n` +
         `Thank you for your business!\n\n` +
         `_This is an automated receipt from WAFlow._`;
}

module.exports = { 
  generateInvoiceFromMessage, 
  processPayment, 
  generateReceiptMessage 
};