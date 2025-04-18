const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');

const BASE_URL = 'https://jobs.euractiv.com';

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

async function fetchJobDescription(relativeUrl) {
  const jobUrl = `${BASE_URL}${relativeUrl}`;
  try {
    const res = await axios.get(jobUrl);
    const $ = cheerio.load(res.data);

    const contentHtml = $('.field-name-body .field-item').html() || '';
    const $desc = cheerio.load(contentHtml);

    $desc("p").each((_, el) => {
      const $el = $desc(el);
      const rawHtml = $el.html()?.toLowerCase().replace(/\s+/g, " ").trim() || "";
    
      if (
        rawHtml.includes("you found this position advertised") ||
        rawHtml.includes("mention that you found this job") ||
        rawHtml.includes("Euractiv") ||
        rawHtml.includes("arial_msfontservice")
      ) {
        $el.remove();
      }
    });

    return decode($desc.html() || '').trim();
  } catch (err) {
    console.error(`❌ Failed to fetch job description from ${relativeUrl}:`, err.message);
    return '';
  }
}

async function importJobsFromEuractiv() {
  await dbConnect();

  const res = await axios.get(BASE_URL); // 👈 Use homepage instead of /jobs
  const $ = cheerio.load(res.data);

  const rows = $('tbody tr');
  for (let i = 0; i < Math.min(100, rows.length); i++) {
    const row = rows[i];
    const titleEl = $(row).find('.views-field-title-1 a');
    const relativeLink = titleEl.attr('href');
    const title = decode(titleEl.text().trim());

    const company = decode($(row).find('.views-field-field-ea-job-company-nref a').text().trim() || 'Unknown Company');
    const location = decode($(row).find('.views-field-field-ea-shared-location-tref a').text().trim() || '');
    const category = decode($(row).find('.views-field-field-ea-shared-category-tref a').text().trim() || '');

    const applyLink = `${BASE_URL}${relativeLink}`;
    const isInternalLink = applyLink.startsWith(BASE_URL);
    const finalApplyLink = isInternalLink ? '' : applyLink;

    const existing = await JobModel.findOne({ applyLink });
    if (existing) {
      console.log(`⚠️ Skipping duplicate: ${title}`);
      continue;
    }

    const fullDescription = await fetchJobDescription(relativeLink);

    const id = uuidv4();
    const slug = generateSlug(title, company, id);

    const description = fullDescription || '(No description available)';

    // ✅ Actually assign calculated seniority
    let seniority = 'mid-level';
    const loweredTitle = title.toLowerCase();
    if (loweredTitle.includes('intern')) seniority = 'intern';
    else if (loweredTitle.includes('junior')) seniority = 'junior';
    else if (loweredTitle.includes('senior')) seniority = 'senior';

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
      applyLink: finalApplyLink,
      createdAt: new Date(),
      updatedAt: new Date(),
      expiresOn: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      seniority, // 👈 this was missing before
      plan: 'basic',
      source: 'losers'
    });

    try {
      await newJob.save();
      console.log(`✅ Saved: ${title}`);
    } catch (err) {
      console.error(`❌ Error saving ${title}:`, err.message);
    }
  }

  mongoose.connection.close();
}

importJobsFromEuractiv();
