// testEmail.js - A simple script to test the Resend email functionality
require('dotenv').config();
const { sendEmail, generateSalesEmailContent } = require('./helperFunctions/emailUtils');

async function testEmailSending() {
  console.log('🧪 Testing email sending functionality...');
  console.log(`📧 Using email from: ${process.env.EMAIL_FROM}`);
  console.log(`🔑 API Key configured: ${process.env.RESEND_API_KEY ? 'Yes (first 5 chars: ' + process.env.RESEND_API_KEY.substring(0, 5) + '...)' : 'No'}`);
  
  // Test recipient - replace with your own email for testing
  const testEmail = 'madan.cheon@gmail.com'; // Replace this with your email
  
  // Email content
  const subject = 'Test - Eurobrussels charges €1,400. We charge €100';
  const htmlContent = generateSalesEmailContent();
  
  try {
    console.log(`📤 Sending test email to: ${testEmail}`);
    const result = await sendEmail(testEmail, subject, htmlContent, {
      jobTitle: 'Test Job Position',
      companyName: 'Test Company',
      source: 'test'
    });
    
    if (result.error) {
      console.error('❌ Error sending email:', result.error);
    } else {
      console.log('✅ Email sent successfully!');
      console.log('📊 Response:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('❌ Exception while sending email:', error);
  }
}

// Run the test
testEmailSending();