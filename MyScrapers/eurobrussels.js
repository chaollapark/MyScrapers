const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
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

async function fetchJobDescription(detailUrl) {
  const fullUrl = `${BASE_URL}${detailUrl}`;
  try {
    const res = await axios.get(fullUrl);
    const $ = cheerio.load(res.data);

    // 🧹 Remove unwanted content
    $('.apply.fw-bold.mt-4.mb-3').remove();
    $('.shareJob').closest('.row').remove(); // whole row with social icons

    const descriptionHtml = $('.jobDisplay').html() || '';

    // 🔗 Handle external apply link
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
      const detailPath = titleEl.attr('href');
      const company = decode(box.find('.companyName').text().trim());
      const location = decode(box.find('.location').text().trim());

      const { description, finalApplyLink } = await fetchJobDescription(detailPath);
      const applyLink = finalApplyLink || `${BASE_URL}${detailPath}`;

      const exists = await JobModel.findOne({ applyLink });
      if (exists) {
        console.log(`⚠️ Skipping duplicate: ${title}`);
        continue;
      }

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
        createdAt: new Date(),
        updatedAt: new Date(),
        expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        seniority,
        plan: 'basic',
        source: 'eurobrussels'
      });

      await job.save();
      console.log(`✅ Saved: ${title}`);
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
      .slice(0, 100); // 🔍 Just 3 companies for now

    for (const path of companyLinks) {
      console.log(`🌍 Scraping jobs at: ${path}`);
      await scrapeCompanyJobs(path, 1); // 🔍 Just 1 job per company
    }
  } catch (err) {
    console.error('❌ Error loading main page:', err.message);
  } finally {
    mongoose.connection.close();
  }
}

scrapeAllPremiumCompanies();
