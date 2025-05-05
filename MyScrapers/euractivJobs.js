// importJobsFromEuractiv.js
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText } = require('./helperFunctions/emailUtils');
require('dotenv').config();

/**
 * Generate custom email content for Euractiv contacts
 * @returns {string} - HTML email content
 */
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

const BASE_URL = 'https://jobs.euractiv.com';

// ─── 1) Normalize URLs so "/job/123/" ≡ "/job/123"
function normalizeLink(link) {
  return link.split('?')[0].replace(/\/$/, '');
}

function generateSlug(title, companyName, id) {
  const processString = (str) =>
    (str || '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

  const titleSlug = processString(title) || 'untitled';
  const companySlug = processString(companyName) || 'unknown-company';
  const shortId = id.slice(-6);
  return `${titleSlug}-at-${companySlug}-${shortId}`;
}

// ─── 2) Fetch & clean the job description, with broader selectors & a length log
async function fetchJobDescription(relativeUrl) {
  const jobUrl = `${BASE_URL}${relativeUrl}`;
  try {
    const res = await axios.get(jobUrl);
    const $ = cheerio.load(res.data);

    // try two different class conventions
    const contentHtml =
      $('.field--name-body .field__item').html() ||
      $('.field-name-body .field-item').html() ||
      '';

    if (!contentHtml) {
      console.warn(`⚠️ No description HTML for ${relativeUrl}`);
      return { description: '', emails: [] };
    }

    const $desc = cheerio.load(contentHtml);
    $desc('p').each((_, el) => {
      const $el = $desc(el);
      const txt = $el.html()?.toLowerCase().replace(/\s+/g, ' ').trim() || '';
      if (
        txt.includes('you found this position advertised') ||
        txt.includes('mention that you found this job') ||
        txt.includes('euractiv') ||
        txt.includes('arial_msfontservice')
      ) {
        $el.remove();
      }
    });

    const cleaned = decode($desc.html() || '').trim();
    console.log(`ℹ️ [Desc length] ${relativeUrl}: ${cleaned.length}`);
    
    // Extract email addresses from the job description
    const emails = extractEmailsFromText(cleaned);
    
    // Also try to find email in the contact information
    const contactInfo = $('.contact-info, .contact, .field--name-field-ea-job-contact-email');
    if (contactInfo.length) {
      const contactText = contactInfo.text();
      const contactEmails = extractEmailsFromText(contactText);
      emails.push(...contactEmails);
    }
    
    // Look for mailto: links which often contain emails
    $('a[href^="mailto:"]').each((_, el) => {
      const mailtoHref = $(el).attr('href');
      if (mailtoHref) {
        const email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
        if (email && email.includes('@')) {
          emails.push(email);
        }
      }
    });
    
    // Look for spans or divs with class containing 'email'
    $('.email, [class*="email"], [class*="contact"]').each((_, el) => {
      const emailText = $(el).text();
      const foundEmails = extractEmailsFromText(emailText);
      emails.push(...foundEmails);
    });
    
    return { 
      description: cleaned, 
      emails: [...new Set(emails)] // Remove duplicates
    };
  } catch (err) {
    console.error(`❌ Failed to fetch description from ${relativeUrl}:`, err.message);
    return { description: '', emails: [] };
  }
}

async function importJobsFromEuractiv() {
  await dbConnect();

  // Track statistics
  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0
  };

  console.log('\n🚀 Starting Euractiv Jobs scraper with email sending feature...');
  console.log(`📧 Email sending ${process.env.RESEND_API_KEY ? 'ENABLED' : 'DISABLED (RESEND_API_KEY not configured)'}\n`);

  // ─── 3) Make sure the unique index exists (will error if duplicates still in DB)
  await JobModel.syncIndexes();

  // ─── 4) Pre‑load every saved link into a Set for fast in‑memory checks
  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  const res = await axios.get(BASE_URL);
  const $ = cheerio.load(res.data);
  const rows = $('tbody tr');
  console.log(`🔍 Found ${rows.length} job listings to process\n`);

  for (let i = 0; i < Math.min(200, rows.length); i++) {
    stats.processed++;
    const row = rows[i];
    const titleEl = $(row).find('.views-field-title-1 a');
    const rawLink = titleEl.attr('href');
    if (!rawLink) continue;

    // ─── 5) Normalize & skip duplicates in‑memory
    const relativeLink = normalizeLink(rawLink);
    if (existingLinks.has(relativeLink)) {
      console.log(`⚠️ Skipping duplicate: ${relativeLink}`);
      continue;
    }

    // … your existing scraping code …
    const title = decode(titleEl.text().trim());
    const company = decode(
      $(row).find('.views-field-field-ea-job-company-nref a').text().trim() ||
      'Unknown Company'
    );
    const location = decode(
      $(row).find('.views-field-field-ea-shared-location-tref a').text().trim() || ''
    );
    const category = decode(
      $(row).find('.views-field-field-ea-shared-category-tref a').text().trim() || ''
    );
    const fullApplyLink = `${BASE_URL}${relativeLink}`;
    const { description: fullDescription, emails } = await fetchJobDescription(relativeLink);
    
    // Log found emails
    if (emails && emails.length > 0) {
      console.log(`🔍 Found ${emails.length} email(s) in job: ${title}`);
    }

    const id = uuidv4();
    const slug = generateSlug(title, company, id);
    const description = fullDescription || '(No description available)';

    let seniority = 'mid-level';
    const lowered = title.toLowerCase();
    if (lowered.includes('intern')) seniority = 'intern';
    else if (lowered.includes('junior')) seniority = 'junior';
    else if (lowered.includes('senior')) seniority = 'senior';

    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title,
      slug,
      description,
      companyName: company,
      sourceAgency: '',
      contractType: '',
      vacancyType: '',
      tags: [category],
      remote: 'no',
      type: 'full-time',
      salary: 0,
      city: location,
      country: location,
      state: '',
      applyLink: fullApplyLink,
      relativeLink,           // ← now normalized
      contactEmail: emails.length > 0 ? emails[0] : null, // Save primary email if found
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      seniority,
      plan: 'basic',
      source: 'euractiv'
    });

    try {
      // ─── 6) Save & add to cache so rest of this run skips it
      await newJob.save();
      existingLinks.add(relativeLink);
      console.log(`✅ Saved: ${title}`);
      
      // Send sales emails to found contacts if configured
      if (process.env.RESEND_API_KEY && emails.length > 0) {
        try {
          const emailSubject = "Euractiv costs €1000 we charge €100";
          const emailContent = generateEuractivEmailContent(); // Use Euractiv-specific email content
          const sentEmails = new Set();
          
          for (const email of emails) {
            // Skip if already sent to this address
            if (sentEmails.has(email)) continue;
            
            // Send the email using Resend API
            const result = await sendEmail(email, emailSubject, emailContent, {
              jobTitle: title,
              companyName: company,
              source: 'euractiv'
            });
            
            if (!result.error) {
              sentEmails.add(email);
              console.log(`📨 Sales email sent to ${email} for ${title} at ${company}`);
              
              // Small delay to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
          
          console.log(`📊 Sent emails to ${sentEmails.size} contacts for job: ${title}`);
        } catch (emailErr) {
          console.error(`❌ Error sending sales emails for ${title}:`, emailErr.message);
        }
      } else if (emails.length > 0 && !process.env.RESEND_API_KEY) {
        console.log(`⚠️ RESEND_API_KEY not configured. Skipping email sending.`);
      }
    } catch (err) {
      // ─── 7) Catch the unique‐index violation if it ever races
      if (err.code === 11000) {
        console.log(`⚠️ Duplicate caught by DB index: ${relativeLink}`);
      } else {
        console.error(`❌ Error saving ${title}:`, err.message);
      }
    }
  }

  // Print final stats
  console.log('\n📊 FINAL STATISTICS:');
  console.log(`Jobs processed: ${stats.processed}`);
  console.log(`Jobs saved: ${stats.saved}`);
  console.log(`Emails found: ${stats.emailsFound}`);
  console.log(`Sales emails sent: ${stats.emailsSent}\n`);
  
  await mongoose.connection.close();
  console.log('✅ Scraping completed');
}

importJobsFromEuractiv();
