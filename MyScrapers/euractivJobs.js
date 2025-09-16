const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');
const { sendEmail, extractEmailsFromText, generateSalesEmailContent } = require('./helperFunctions/emailUtils');
require('dotenv').config();

/*
 * Euractiv jobs scraper (2025).
 *
 * The Euractiv job board moved away from a simple tabular listing and now uses
 * paginated “browse jobs” pages. Each page contains multiple job cards with
 * class names like `.eu-job-card`. The cards include the job title, one or
 * more category tags and a link to the full job description. This script
 * iterates through the paginated listing, extracts new jobs that are not
 * already stored in the database, fetches the details for each job and
 * optionally sends a sales email to any contact addresses found in the
 * description.  The overall structure and saving logic mirrors the original
 * `importJobsFromEuractiv.js` used on the legacy table view but is adapted to
 * the new HTML structure.
 */

const BASE_URL = 'https://jobs.euractiv.com';

/**
 * Normalise a job link by removing the domain, any query string and any
 * trailing slash.  This ensures that duplicate checks match variations such
 * as `/jobs/abc/?utm_source=x` and `/jobs/abc/`.
 *
 * @param {string} link A full or relative URL
 * @returns {string} Normalised relative path beginning with '/'
 */
function normalizeLink(link) {
  if (!link) return '';
  let url = link;
  // strip domain
  if (url.startsWith(BASE_URL)) {
    url = url.substring(BASE_URL.length);
  }
  // remove query string
  url = url.split('?')[0];
  // remove trailing slash (but keep root slash)
  if (url.length > 1 && url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  // ensure leading slash
  if (!url.startsWith('/')) {
    url = '/' + url;
  }
  return url;
}

/**
 * Generate a URL friendly slug based on the title and company.
 *
 * @param {string} title The job title
 * @param {string} companyName Company name
 * @param {string} id Unique identifier
 */
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

/**
 * Attempt to extract a reasonably clean description, company name, and any email addresses
 * from a job details page.  Euractiv job pages use a variety of markup
 * generated via the Visual Composer plugin and do not expose a single
 * container class for the description.  To handle this we try a range of
 * selectors and fall back to concatenating all paragraph tags on the page.
 * We also look for `mailto:` links and any text that matches an email
 * pattern.
 *
 * @param {string} relativeUrl The normalised path to the job (e.g. '/jobs/foo')
 * @returns {Promise<{description: string, emails: string[], companyName: string}>}
 */
async function fetchJobDescription(relativeUrl) {
  const jobUrl = `${BASE_URL}${relativeUrl}`;
  try {
    const res = await axios.get(jobUrl);
    const $ = cheerio.load(res.data);

    // Try several selectors for the main body of the job description.  These
    // selectors cover common patterns observed on Euractiv job pages.  If none
    // match, we will later fall back to collecting all paragraphs.
    let descriptionHtml =
      $('.eu-single-job__main__content__info').html() ||
      $('.eu-single-job__description').html() ||
      $('.single-job-description').html() ||
      $('.single-job-description > *').html() ||
      $('.wpb_wrapper').html() ||
      '';

    // Fallback: join all paragraphs on the page (this may include footer
    // content but is better than returning nothing).  We intentionally use
    // `.text()` rather than `.html()` here because paragraphs might not be
    // nested in a typical way within the Visual Composer structure.
    if (!descriptionHtml) {
      const paragraphs = $('p')
        .map((_, el) => $(el).html())
        .get()
        .join('<br>');
      descriptionHtml = paragraphs;
    }

    // Load the description HTML separately to clean and extract text.
    const $desc = cheerio.load(descriptionHtml || '');
    // Remove script/style tags and other unwanted nodes.
    $desc('script, style, noscript').remove();
    // Remove paragraphs that contain only Euractiv attribution or font tags.
    $desc('p').each((_, el) => {
      const txt = $desc(el).text().toLowerCase().replace(/\s+/g, ' ').trim();
      if (
        txt.includes('euractiv') ||
        txt.includes('mention that you found this job') ||
        txt.includes('arial_msfontservice')
      ) {
        $desc(el).remove();
      }
    });
    // Extract plain text and normalise whitespace.
    const cleaned = decode($desc.text() || '').replace(/\s+/g, ' ').trim();

    // Collect email addresses.
    let emails = extractEmailsFromText(cleaned);
    // Extract emails from mailto: links on the main page as well.
    $('a[href^="mailto:"]').each((_, el) => {
      const mailtoHref = $(el).attr('href');
      if (mailtoHref) {
        const email = mailtoHref.replace('mailto:', '').split('?')[0].trim();
        if (email && email.includes('@')) {
          emails.push(email);
        }
      }
    });
    // Extract emails from spans/divs with classes containing 'email' or 'contact'.
    $('[class*=email], [class*=contact]').each((_, el) => {
      const text = $(el).text();
      const found = extractEmailsFromText(text);
      if (found && found.length) emails.push(...found);
    });
    // Deduplicate
    emails = [...new Set(emails)];

    // Extract company name from multiple sources
    let companyName = 'Unknown Company';
    
    // Method 1: Look for company logo image src which often contains company name
    const logoImg = $('.eu-single-job__main__content__header__image img, .company-logo img, [class*="logo"] img').first();
    if (logoImg.length) {
      const logoSrc = logoImg.attr('src') || '';
      const logoMatch = logoSrc.match(/\/([^\/\-_]+)[-_]?logo/i);
      if (logoMatch && logoMatch[1]) {
        companyName = logoMatch[1].replace(/[-_]/g, ' ').trim();
      }
    }
    
    // Method 2: Look for "About [Company]:" patterns in the description
    if (companyName === 'Unknown Company') {
      const aboutMatch = cleaned.match(/(?:About|Company:|Organization:)\s+([A-Z][^:.,\n]*?)(?:\s*:|\s*\n|$)/i);
      if (aboutMatch && aboutMatch[1]) {
        companyName = aboutMatch[1].trim();
      }
    }
    
    // Method 3: Extract from email domain (as fallback)
    if (companyName === 'Unknown Company' && emails.length > 0) {
      const firstEmail = emails[0];
      const domain = firstEmail.split('@')[1];
      if (domain && !domain.includes('gmail') && !domain.includes('hotmail') && !domain.includes('yahoo')) {
        const domainParts = domain.split('.');
        if (domainParts.length >= 2) {
          companyName = domainParts[0].replace(/[-_]/g, ' ').trim();
          // Capitalize first letter
          companyName = companyName.charAt(0).toUpperCase() + companyName.slice(1);
        }
      }
    }
    
    // Method 4: Look for patterns like "join [company]" or "work at [company]"
    if (companyName === 'Unknown Company') {
      const joinMatch = cleaned.match(/(?:join|work\s+at|apply\s+to)\s+([A-Z][A-Za-z\s&]{2,20})(?:\s|[.!,])/i);
      if (joinMatch && joinMatch[1]) {
        companyName = joinMatch[1].trim();
      }
    }

    return {
      description: cleaned || '(No description available)',
      emails,
      companyName
    };
  } catch (err) {
    console.error(`❌ Failed to fetch description from ${relativeUrl}:`, err.message);
    return { description: '', emails: [], companyName: 'Unknown Company' };
  }
}

/**
 * Main import function.  Iterates through paginated job listings, scrapes new
 * jobs and stores them in MongoDB.  Uses an in-memory cache of existing
 * relative links to avoid duplicates.  Optionally sends a sales email to
 * contacts found in the job description when SENDGRID_API_KEY is configured.
 */
async function importJobsFromEuractiv() {
  await dbConnect();

  // Statistics for logging and debugging
  let stats = {
    processed: 0,
    saved: 0,
    emailsFound: 0,
    emailsSent: 0
  };

  console.log('\n🚀 Starting Euractiv Jobs scraper with email sending feature...');
  console.log(`📧 Email sending ${process.env.SENDGRID_API_KEY ? 'ENABLED' : 'DISABLED (SENDGRID_API_KEY not configured)'}`);

  // Ensure indexes exist (will error if duplicates still in DB)
  await JobModel.syncIndexes();

  // Preload relative links from DB for quick duplicate checking
  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  let page = 1;
  let continuePaging = true;

  // Loop through pages until there are no more job cards or we've processed 200 jobs
  while (continuePaging && stats.processed < 200) {
    const pageUrl = `${BASE_URL}/browse-jobs/?paged=${page}`;
    console.log(`\n📄 Fetching job list page ${page}: ${pageUrl}`);
    let res;
    try {
      res = await axios.get(pageUrl);
    } catch (err) {
      console.error(`❌ Error fetching job list page ${page}:`, err.message);
      break;
    }
    const $ = cheerio.load(res.data);
    const cards = $('.eu-job-card');

    if (!cards || cards.length === 0) {
      console.log(`⚠️ No job cards found on page ${page}. Stopping.`);
      break;
    }

    for (let i = 0; i < cards.length && stats.processed < 200; i++) {
      stats.processed++;
      const card = cards[i];
      const titleEl = $(card).find('.eu-job-card__title a').first();
      const rawLink = titleEl.attr('href');
      if (!rawLink) continue;
      const relativeLink = normalizeLink(rawLink);

      // Skip duplicates in-memory
      if (existingLinks.has(relativeLink)) {
        console.log(`⚠️ Skipping duplicate: ${relativeLink}`);
        continue;
      }

      const title = decode(titleEl.text().trim());
      const category = decode(
        $(card).find('.eu-job-card__category a').text().trim() || ''
      );
      // Determine job type (default to full-time).  We inspect the pill labels
      // found within `.eu-job-card__pills__item`, ignoring the “FEATURED JOB” tag.
      const pillTexts = $(card)
        .find('.eu-job-card__pills__item')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter((text) => text && text.toLowerCase() !== 'featured job');
      let contractType = '';
      pillTexts.forEach((p) => {
        const pt = p.toLowerCase();
        if (pt.includes('full')) contractType = 'full-time';
        else if (pt.includes('part')) contractType = 'part-time';
        else if (pt.includes('freelancer')) contractType = 'freelancer';
      });
      if (!contractType) contractType = 'full-time';

      // Fetch description, emails, and company name
      const { description: fullDescription, emails, companyName: extractedCompanyName } = await fetchJobDescription(relativeLink);
      if (emails && emails.length) {
        stats.emailsFound += emails.length;
        console.log(`🔍 Found ${emails.length} email(s) in job: ${title}`);
      }

      const id = uuidv4();
      const company = extractedCompanyName || 'Unknown Company';
      const slug = generateSlug(title, company, id);
      const description = fullDescription || '(No description available)';
      // Determine seniority from title
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
        contractType,
        vacancyType: '',
        tags: category ? [category] : [],
        remote: 'no',
        type: contractType,
        salary: 0,
        city: '',
        country: '',
        state: '',
        applyLink: `${BASE_URL}${relativeLink}`,
        relativeLink,
        contactEmail: emails && emails.length > 0 ? emails[0] : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        seniority,
        plan: 'basic',
        source: 'euractiv'
      });

      try {
        await newJob.save();
        stats.saved++;
        existingLinks.add(relativeLink);
        console.log(`✅ Saved: ${title}`);
        // Send sales emails if configured
        if (process.env.SENDGRID_API_KEY && emails && emails.length > 0) {
          try {
            const emailSubject = 'Euractiv costs €1000 we charge €100';
            const emailContent = generateSalesEmailContent();
            const sentEmails = new Set();
            for (const email of emails) {
              if (sentEmails.has(email)) continue;
              const result = await sendEmail(email, emailSubject, emailContent, {
                jobTitle: title,
                companyName: company,
                source: 'euractiv'
              });
              if (!result.error) {
                sentEmails.add(email);
                stats.emailsSent++;
                console.log(`📨 Sales email sent to ${email} for ${title}`);
                // Delay to avoid rate limiting
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
            }
            console.log(`📊 Sent emails to ${sentEmails.size} contacts for job: ${title}`);
          } catch (emailErr) {
            console.error(`❌ Error sending sales emails for ${title}:`, emailErr.message);
          }
        } else if (emails && emails.length > 0 && !process.env.SENDGRID_API_KEY) {
          console.log('⚠️ SENDGRID_API_KEY not configured. Skipping email sending.');
        }
      } catch (err) {
        if (err.code === 11000) {
          console.log(`⚠️ Duplicate caught by DB index: ${relativeLink}`);
        } else {
          console.error(`❌ Error saving ${title}:`, err.message);
        }
      }
    }
    // Determine whether there is another page.  If a 'next' page-numbers link
    // exists, increment page; otherwise stop paging.
    const nextHref = $('.pagination .next.page-numbers').attr('href');
    if (nextHref) {
      page++;
    } else {
      continuePaging = false;
    }
  }

  console.log('\n📊 FINAL STATISTICS:');
  console.log(`Jobs processed: ${stats.processed}`);
  console.log(`Jobs saved: ${stats.saved}`);
  console.log(`Emails found: ${stats.emailsFound}`);
  console.log(`Sales emails sent: ${stats.emailsSent}`);

  await mongoose.connection.close();
  console.log('✅ Scraping completed');
}

// Kick off the scraper when invoked directly
importJobsFromEuractiv().catch((err) => {
  console.error('❌ Unhandled error in Euractiv scraper:', err);
  mongoose.connection.close();
});