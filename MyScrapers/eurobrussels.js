const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Make sure this includes relativeLink schema
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

const BASE_URL = 'https://www.eurobrussels.com';

function generateSlug(title, company, id) {
  const process = (str) =>
    (str || '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  return `${process(title)}-at-${process(company)}-${id.slice(-6)}`;
}

function normalizeLink(link) {
  return link?.split('?')[0]?.replace(/\/$/, '') || '';
}

async function fetchJobDescription(relativeLink) {
  const fullUrl = `${BASE_URL}${relativeLink}`;
  try {
    const res = await axios.get(fullUrl);
    const $ = cheerio.load(res.data);

    $('.apply.fw-bold.mt-4.mb-3').remove();
    $('.shareJob').closest('.row').remove();

    const descriptionHtml = $('.jobDisplay').html() || '';
    const descriptionText = decode(descriptionHtml).trim();
    
    // Extract email addresses from the description
    const emails = extractEmailsFromText(descriptionText);
    
    // Look for contact info sections which might contain emails
    const contactInfo = $('.contact-info');
    if (contactInfo.length) {
      const contactText = contactInfo.text();
      const contactEmails = extractEmailsFromText(contactText);
      emails.push(...contactEmails);
    }
    
    // Try to find email in application instructions
    const applyInstructions = $('.apply-instructions, .how-to-apply');
    if (applyInstructions.length) {
      const applyText = applyInstructions.text();
      const applyEmails = extractEmailsFromText(applyText);
      emails.push(...applyEmails);
    }

    const applyBtn = $('a.btn.callToAction');
    let externalApplyLink = '';

    if (applyBtn.length > 0) {
      const applyHref = applyBtn.attr('href');
      if (applyHref && applyHref.startsWith('/job/track_click')) {
        const trackingUrl = `${BASE_URL}${applyHref}`;
        try {
          const redirectRes = await axios.get(trackingUrl, {
            maxRedirects: 0,
            validateStatus: (status) => status === 302 || status === 301,
          });
          externalApplyLink = redirectRes.headers.location || '';
        } catch (err) {
          console.warn(`⚠️ Could not resolve redirect for: ${trackingUrl}`);
        }
      }
    }

    return {
      description: descriptionText,
      finalApplyLink: externalApplyLink,
      emails: [...new Set(emails)] // Remove duplicates
    };
  } catch (err) {
    console.error(`❌ Failed to fetch job detail: ${fullUrl}`, err.message);
    return { description: '', finalApplyLink: '', emails: [] };
  }
}

/**
 * Send sales email to contact emails found in job descriptions
 * @param {Array} emails - List of email addresses
 * @param {object} jobData - Job data for context
 */
async function sendSalesEmails(emails, jobData) {
  if (!emails || emails.length === 0) return;
  
  const { title, companyName } = jobData;
  const emailSubject = "Eurobrussels charges €1,400. We charge €100";
  const emailContent = generateSalesEmailContent();
  
  // Track already sent emails to avoid duplicates
  const sentEmails = new Set();
  
  for (const email of emails) {
    // Skip if already sent to this address
    if (sentEmails.has(email)) continue;
    
    try {
      // Send the email using Resend API
      const result = await sendEmail(email, emailSubject, emailContent, {
        jobTitle: title,
        companyName: companyName,
        source: 'eurobrussels'
      });
      
      if (!result.error) {
        sentEmails.add(email);
        console.log(`📨 Sales email sent to ${email} for ${title} at ${companyName}`);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`❌ Failed to send sales email to ${email}:`, error);
    }
  }
  
  return sentEmails.size;
}

async function scrapeCompanyJobs(companyPath, maxJobs = 3) {
  try {
    const res = await axios.get(`${BASE_URL}${companyPath}`);
    const $ = cheerio.load(res.data);
    const jobBoxes = $('.ps-3');
    
    // Track stats for this company
    let companyStats = {
      processed: 0,
      saved: 0,
      emailsFound: 0,
      emailsSent: 0
    };

    for (let i = 0; i < Math.min(maxJobs, jobBoxes.length); i++) {
      const box = $(jobBoxes[i]);
      const titleEl = box.find('h3 a');
      const title = decode(titleEl.text().trim());
      const rawLink = titleEl.attr('href');
      const relativeLink = normalizeLink(rawLink);
      const company = decode(box.find('.companyName').text().trim());
      const location = decode(box.find('.location').text().trim());
      
      companyStats.processed++;

      // 🔍 Duplicate check by relativeLink
      const exists = await JobModel.findOne({ relativeLink });
      if (exists) {
        console.log(`⚠️ Skipping duplicate: ${relativeLink}`);
        continue;
      }

      const { description, finalApplyLink, emails } = await fetchJobDescription(relativeLink);
      const applyLink = finalApplyLink || `${BASE_URL}${relativeLink}`;
      const id = uuidv4();
      const slug = generateSlug(title, company, id);
      
      // Log found emails
      if (emails && emails.length > 0) {
        console.log(`🔍 Found ${emails.length} email(s) in job: ${title}`);
        companyStats.emailsFound += emails.length;
      }

      let seniority = 'mid-level';
      const lowered = title.toLowerCase();
      if (lowered.includes('intern')) seniority = 'intern';
      else if (lowered.includes('junior')) seniority = 'junior';
      else if (lowered.includes('senior')) seniority = 'senior';

      const job = new JobModel({
        _id: new mongoose.Types.ObjectId(),
        title,
        slug,
        description,
        companyName: company,
        sourceAgency: '',
        contractType: '',
        vacancyType: '',
        tags: [],
        remote: 'no',
        type: 'full-time',
        salary: 0,
        city: location,
        country: '',
        state: '',
        applyLink,
        relativeLink, // ✅ Standardized dedupe field
        contactEmail: emails.length > 0 ? emails[0] : null, // Save primary email if found
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        seniority,
        plan: 'basic',
        source: 'eurobrussels'
      });

      try {
        await job.save();
        companyStats.saved++;
        console.log(`✅ Saved: ${title}`);
        
        // Send sales emails to found contacts if RESEND_API_KEY is configured
        if (process.env.RESEND_API_KEY && emails.length > 0) {
          const emailsSent = await sendSalesEmails(emails, {
            title,
            companyName: company,
            location
          });
          
          if (emailsSent) {
            companyStats.emailsSent += emailsSent;
          }
        } else if (emails.length > 0 && !process.env.RESEND_API_KEY) {
          console.log(`⚠️ RESEND_API_KEY not configured. Skipping email sending.`);
        }
      } catch (err) {
        if (err.code === 11000) {
          console.log(`⚠️ Duplicate caught by DB index: ${relativeLink}`);
        } else {
          console.error(`❌ Error saving ${title}:`, err.message);
        }
      }
    }
    
    // Log company stats
    console.log(`\n📊 Stats for ${companyPath}:`);
    console.log(`Jobs processed: ${companyStats.processed}`);
    console.log(`Jobs saved: ${companyStats.saved}`);
    console.log(`Emails found: ${companyStats.emailsFound}`);
    console.log(`Emails sent: ${companyStats.emailsSent}\n`);
    
    return companyStats;
  } catch (err) {
    console.error(`❌ Error scraping company jobs from ${companyPath}:`, err.message);
    return { processed: 0, saved: 0, emailsFound: 0, emailsSent: 0 };
  }
}

async function scrapeAllPremiumCompanies() {
  await dbConnect();

  // Overall stats
  let totalStats = {
    companies: 0,
    jobs: {
      processed: 0,
      saved: 0
    },
    emails: {
      found: 0,
      sent: 0
    }
  };

  try {
    console.log('\n🚀 Starting Eurobrussels scraper with email sending feature...');
    console.log(`📧 Email sending ${process.env.RESEND_API_KEY ? 'ENABLED' : 'DISABLED (RESEND_API_KEY not configured)'}\n`);
    
    const homepage = await axios.get(BASE_URL);
    const $ = cheerio.load(homepage.data);

    const companyLinks = $('a.animatedPremiumJobLogoWrapper')
      .map((_, el) => $(el).attr('href'))
      .get()
      .filter((href) => href && href.startsWith('/jobs_at/'))
      .slice(0, 100);

    console.log(`🔍 Found ${companyLinks.length} companies to scrape\n`);

    for (const path of companyLinks) {
      console.log(`🌍 Scraping jobs at: ${path}`);
      totalStats.companies++;
      
      const companyStats = await scrapeCompanyJobs(path, 3); // Increased from 1 to 3 jobs per company
      
      // Update total stats
      totalStats.jobs.processed += companyStats.processed;
      totalStats.jobs.saved += companyStats.saved;
      totalStats.emails.found += companyStats.emailsFound;
      totalStats.emails.sent += companyStats.emailsSent;
    }
  } catch (err) {
    console.error('❌ Error loading main page:', err.message);
  } finally {
    // Print final stats
    console.log('\n📊 FINAL STATISTICS:');
    console.log(`Companies scraped: ${totalStats.companies}`);
    console.log(`Jobs processed: ${totalStats.jobs.processed}`);
    console.log(`Jobs saved: ${totalStats.jobs.saved}`);
    console.log(`Emails found: ${totalStats.emails.found}`);
    console.log(`Sales emails sent: ${totalStats.emails.sent}\n`);
    
    mongoose.connection.close();
    console.log('✅ Scraping completed');
  }
}

scrapeAllPremiumCompanies();
