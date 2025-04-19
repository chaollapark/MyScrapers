// importJobsFromEuractiv.js
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');

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
      return '';
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
    return cleaned;
  } catch (err) {
    console.error(`❌ Failed to fetch description from ${relativeUrl}:`, err.message);
    return '';
  }
}

async function importJobsFromEuractiv() {
  await dbConnect();

  // ─── 3) Make sure the unique index exists (will error if duplicates still in DB)
  await JobModel.syncIndexes();

  // ─── 4) Pre‑load every saved link into a Set for fast in‑memory checks
  const existingLinks = new Set(
    (await JobModel.find({}, 'relativeLink')).map((d) => d.relativeLink)
  );

  const res = await axios.get(BASE_URL);
  const $ = cheerio.load(res.data);
  const rows = $('tbody tr');

  for (let i = 0; i < Math.min(200, rows.length); i++) {
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
    const fullDescription = await fetchJobDescription(relativeLink);

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
    } catch (err) {
      // ─── 7) Catch the unique‐index violation if it ever races
      if (err.code === 11000) {
        console.log(`⚠️ Duplicate caught by DB index: ${relativeLink}`);
      } else {
        console.error(`❌ Error saving ${title}:`, err.message);
      }
    }
  }

  await mongoose.connection.close();
}

importJobsFromEuractiv();
