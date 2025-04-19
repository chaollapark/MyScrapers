const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Make sure this includes relativeLink schema
const dbConnect = require('./dbConnect');

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
      description: decode(descriptionHtml).trim(),
      finalApplyLink: externalApplyLink
    };
  } catch (err) {
    console.error(`❌ Failed to fetch job detail: ${fullUrl}`, err.message);
    return { description: '', finalApplyLink: '' };
  }
}

async function scrapeCompanyJobs(companyPath, maxJobs = 3) {
  try {
    const res = await axios.get(`${BASE_URL}${companyPath}`);
    const $ = cheerio.load(res.data);
    const jobBoxes = $('.ps-3');

    for (let i = 0; i < Math.min(maxJobs, jobBoxes.length); i++) {
      const box = $(jobBoxes[i]);
      const titleEl = box.find('h3 a');
      const title = decode(titleEl.text().trim());
      const rawLink = titleEl.attr('href');
      const relativeLink = normalizeLink(rawLink);
      const company = decode(box.find('.companyName').text().trim());
      const location = decode(box.find('.location').text().trim());

      // 🔍 Duplicate check by relativeLink
      const exists = await JobModel.findOne({ relativeLink });
      if (exists) {
        console.log(`⚠️ Skipping duplicate: ${relativeLink}`);
        continue;
      }

      const { description, finalApplyLink } = await fetchJobDescription(relativeLink);
      const applyLink = finalApplyLink || `${BASE_URL}${relativeLink}`;
      const id = uuidv4();
      const slug = generateSlug(title, company, id);

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
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        seniority,
        plan: 'basic',
        source: 'eurobrussels'
      });

      try {
        await job.save();
        console.log(`✅ Saved: ${title}`);
      } catch (err) {
        if (err.code === 11000) {
          console.log(`⚠️ Duplicate caught by DB index: ${relativeLink}`);
        } else {
          console.error(`❌ Error saving ${title}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error(`❌ Error scraping company jobs from ${companyPath}:`, err.message);
  }
}

async function scrapeAllPremiumCompanies() {
  await dbConnect();

  try {
    const homepage = await axios.get(BASE_URL);
    const $ = cheerio.load(homepage.data);

    const companyLinks = $('a.animatedPremiumJobLogoWrapper')
      .map((_, el) => $(el).attr('href'))
      .get()
      .filter((href) => href && href.startsWith('/jobs_at/'))
      .slice(0, 100);

    for (const path of companyLinks) {
      console.log(`🌍 Scraping jobs at: ${path}`);
      await scrapeCompanyJobs(path, 1); // Scrape 1 job per company
    }
  } catch (err) {
    console.error('❌ Error loading main page:', err.message);
  } finally {
    mongoose.connection.close();
  }
}

scrapeAllPremiumCompanies();
