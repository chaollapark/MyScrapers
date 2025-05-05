// testEuractivEmail.js
require('dotenv').config();
const { sendEmail } = require('./helperFunctions/emailUtils');

// Define the Euractiv email content function
function generateEuractivEmailContent() {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
      <h2 style="color: #333;">Euractiv costs €1000 we charge €100</h2>
      
      <p>Hello,</p>
      
      <p>I noticed you're advertising on Euractiv's job board</p>
      
      <p>Why pay €1000 when you could pay just €100 and potentially reach more qualified candidates?</p>
      
      <p>We aggregate listings from all 17 major Brussels job boards and currently rank as the #1 platform for EU-focused job seekers. Our platform is trusted by teams at OpenAI, Anthropic, and Mistral.</p>
      
      <p>Our platform specializes in EU policy, government affairs, and international roles - exactly the kind of positions that appear on Euractiv's job board. But our reach extends across all the major Brussels job boards plus our own direct audience.</p>
      
      <p>If you'd like to discuss how we can help with your recruitment needs or want to learn more about our services, I'd be happy to set up a call.</p>
      
      <p>
        Best regards,<br>
        Madan Chaolla Park<br>
        Zatjob | Founder<br>
        Phone: +393518681664
      </p>
      
      <div style="margin-top: 30px; text-align: center;">
        <a href="http://calendly.com/chaollapark" style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 4px; margin-right: 10px;">Schedule a Meeting</a>
        <a href="https://www.eujobs.co/" style="display: inline-block; padding: 10px 20px; background-color: #008CBA; color: white; text-decoration: none; border-radius: 4px;">Post a Job</a>
      </div>
    </div>
  `;
}

async function testEmail() {
  console.log('🧪 Testing Euractiv email template...');
  
  // Your test email
  const testEmail = 'madan_chaolla@yahoo.co.in'; // Using your email for testing
  
  // Email subject and content
  const subject = "Euractiv charges €1000 we charge €100";
  const htmlContent = generateEuractivEmailContent();
  
  try {
    console.log(`📤 Sending test email to: ${testEmail}`);
    const result = await sendEmail(testEmail, subject, htmlContent, {
      jobTitle: 'Test Job Position',
      companyName: 'Test Company',
      source: 'euractiv-test'
    });
    
    if (result.error) {
      console.error('❌ Error:', result.error);
    } else {
      console.log('✅ Email sent successfully!');
      console.log('📊 Response:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('❌ Error sending email:', error);
  }
}

testEmail();