// emailUtils.js
const { Resend } = require('resend');
const path = require('path');
const fs = require('fs');

// Rate limiting variables
const REQUEST_LIMIT = 2; // Maximum 2 requests per second
const TIME_WINDOW = 1000; // 1 second in milliseconds
let emailQueue = [];
let isProcessingQueue = false;

// Configure dotenv to load from the root directory
require('dotenv').config({ path: path.resolve(process.cwd(), '..', '.env') });

// Debug environment variables
console.log('🔍 Environment check:');
console.log(`- Working directory: ${process.cwd()}`);
console.log(`- API Key available: ${process.env.RESEND_API_KEY ? 'Yes (first chars: ' + process.env.RESEND_API_KEY.substring(0, 5) + '...)' : 'No'}`); 
console.log(`- Email From: ${process.env.EMAIL_FROM || 'Not set'}`); 

// Use API key directly if environment variable fails
const API_KEY = process.env.RESEND_API_KEY || "re_bGAo17Cu_6qzSdaoujccXsWGHFFJc9yFZ";

// Initialize Resend API client
const resend = new Resend(API_KEY);

/**
 * Process the email queue with rate limiting
 * @private
 */
function processEmailQueue() {
  if (emailQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }

  isProcessingQueue = true;
  
  // Take only REQUEST_LIMIT items from the queue
  const batch = emailQueue.slice(0, REQUEST_LIMIT);
  emailQueue = emailQueue.slice(REQUEST_LIMIT);
  
  // Process this batch
  const promises = batch.map(item => sendEmailDirect(item.email, item.subject, item.htmlContent, item.metadata));
  
  // After processing this batch, wait for the time window before processing the next batch
  Promise.all(promises).then(() => {
    setTimeout(() => {
      processEmailQueue();
    }, TIME_WINDOW);
  }).catch(error => {
    console.error('Error processing email batch:', error);
    setTimeout(() => {
      processEmailQueue();
    }, TIME_WINDOW);
  });
}

/**
 * Direct email sending function (without rate limiting)
 * @private
 */
async function sendEmailDirect(toEmail, subject, htmlContent, metadata = {}) {
  try {
    if (!toEmail || !toEmail.includes('@')) {
      console.log('⚠️ Invalid email address:', toEmail);
      return { error: 'Invalid email address' };
    }

    const { companyName, jobTitle, source } = metadata;

    // Log the email being sent for tracking purposes
    console.log(`📧 Sending email to: ${toEmail} for job: ${jobTitle || 'N/A'} at ${companyName || 'Unknown Company'}`);

    const response = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to: toEmail,
      subject: subject,
      html: htmlContent,
      tags: [
        {
          name: 'source',
          value: source || 'scraper',
        },
        {
          name: 'category',
          value: 'job_application',
        }
      ]
    });

    console.log(`✅ Email sent successfully to ${toEmail}`);
    return response;
  } catch (error) {
    console.error(`❌ Failed to send email to ${toEmail}:`, error.message);
    return { error: error.message };
  }
}

/**
 * Send an email using Resend API with rate limiting
 * @param {string} toEmail - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} htmlContent - Email content in HTML format
 * @param {object} metadata - Additional metadata about the job
 * @returns {Promise<object>} - Response or a promise that will be resolved when the email is sent
 */
async function sendEmail(toEmail, subject, htmlContent, metadata = {}) {
  return new Promise((resolve, reject) => {
    // Add to queue
    emailQueue.push({
      email: toEmail,
      subject,
      htmlContent,
      metadata,
      resolve,
      reject
    });
    
    // Start processing queue if not already processing
    if (!isProcessingQueue) {
      processEmailQueue();
    }
  });
}

/**
 * Extract email addresses from text content
 * @param {string} text - Text to search for emails
 * @returns {string[]} - Array of emails found
 */
function extractEmailsFromText(text) {
  if (!text) return [];
  
  const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
  const emails = text.match(EMAIL_PATTERN);
  return emails || [];
}

/**
 * Generate the standard sales email content for EUjobs
 * @param {object} jobData - Job data object
 * @returns {string} - HTML content for the email
 */
function generateSalesEmailContent() {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
      <p>Hi there,</p>
      <p>I saw you posted a job on Eurobrussels.</p>
      <p><strong>Why spend €1,400 on an inferior listing… when ours costs just €100?</strong></p>
      <p>We're the #1 platform for EU-focused job seekers, trusted by teams at OpenAI, Anthropic, and Mistral.</p>
      <p>If you want more support, we also offer a headhunting option:</p>
      <ul>
        <li>€200 upfront</li>
        <li>€1,800 only if you hire one of our candidates.</li>
      </ul>
      <p>That's €1,300 saved — enough to buy your team a great dinner… or just post more roles with us.</p>
      <p>Want to give it a shot?</p>
      <p>
        Madan Chaolla Park,<br>
        To set a meeting click here --> <a href="http://calendly.com/chaollapark">http://calendly.com/chaollapark</a> <--<br>
        To post a job click here --> <a href="https://www.eujobs.co/">https://www.eujobs.co/</a> <--<br>
        Phone: +393518681664<br>
        Zatjob | Founder
      </p>
    </div>
  `;
}

/**
 * Get the current status of the email queue
 * @returns {Object} The status object containing queue length
 */
function getEmailQueueStatus() {
  return {
    queueLength: emailQueue.length,
    isProcessing: isProcessingQueue
  };
}

module.exports = {
  sendEmail,
  extractEmailsFromText,
  generateSalesEmailContent,
  getEmailQueueStatus
};
