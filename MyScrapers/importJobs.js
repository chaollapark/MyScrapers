const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { parseStringPromise } = require('xml2js');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Adjust this path
const dbConnect = require('./dbConnect'); // Adjust this path

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

function extractCategoryValue(categories, domain) {
  if (!Array.isArray(categories)) return '';
  const match = categories.find((c) => c.domain === domain);
  if (!match) return '';
  return typeof match === 'string' ? match : match._ || '';
}

function extractMultipleCategoryValues(categories, domain) {
  if (!Array.isArray(categories)) return [];
  return categories
    .filter((c) => c.domain === domain)
    .map((c) => (typeof c === 'string' ? c : c._ || ''))
    .filter(Boolean);
}

async function importJobsFromRSS() {
  await dbConnect();

  const rssUrl = 'https://agencies-network.europa.eu/node/144/rss_en';
  const response = await fetch(rssUrl);
  const xml = await response.text();

  const data = await parseStringPromise(xml, { explicitArray: false, mergeAttrs: true });

  const items = data.rss.channel.item;
  const jobs = Array.isArray(items) ? items : [items];

  for (const job of jobs) {
    const title = job.title;
    const categories = Array.isArray(job.category) ? job.category : [job.category];
    
    // 🔍 Check if this job already exists
    const applyLink = job.link;
    const existing = await JobModel.findOne({ applyLink });
      if (existing) {
        console.log(`⚠️ Skipping duplicate: ${title}`);
        continue;
      }

    const agencyDisplayName = extractCategoryValue(categories, 'Agency') || 'EU Agency';
    const sourceAgency = extractCategoryValue(categories, 'http://publications.europa.eu/resource/authority/corporate-body');
    const contractType = extractCategoryValue(categories, 'Type of Contract');
    const vacancyType = extractCategoryValue(categories, 'Vacancy type');
    const tags = extractMultipleCategoryValues(categories, 'http://data.europa.eu/uxp/det');

    const rawDescription = job.description || '';
    const decodedDescription = decode(rawDescription);

    const fallbackNote = 'This job listing is from an official EU agency. We pull these directly from trusted sources so you never miss an opportunity—even the ones buried deep in government websites.';

    const description = decodedDescription
      ? `${decodedDescription}\n\n${fallbackNote}`
      : fallbackNote;
      
    const pubDate = job.pubDate;
    const locationStr = extractCategoryValue(categories, 'City, Country');
    const [city = '', country = ''] = locationStr.split(',').map((s) => s.trim());

    const id = uuidv4();
    const slug = generateSlug(title, agencyDisplayName, id);

    try {
      const newJob = new JobModel({
        _id: new mongoose.Types.ObjectId(),
        title,
        slug,
        description,
        companyName: agencyDisplayName,
        sourceAgency,
        contractType,
        vacancyType,
        tags,
        remote: 'no',
        type: 'full-time',
        salary: 0,
        country,
        city,
        state: '',
        countryId: '',
        stateId: '',
        cityId: '',
        postalCode: null,
        street: '',
        jobIcon: '',
        contactName: '',
        contactPhone: '',
        contactEmail: '',
        applyLink,
        createdAt: new Date(pubDate),
        updatedAt: new Date(),
        expiresOn: new Date(new Date(pubDate).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        seniority: 'mid-level',
        plan: 'basic',
        source: 'eu-rss'
      });

      await newJob.save();
      console.log(`✅ Saved: ${title}`);
    } catch (err) {
      if (err.code === 11000) {
        console.log(`⚠️ Skipped (duplicate): ${title}`);
      } else {
        console.error(`❌ Error saving "${title}":`, err.message);
      }
    }
  }

  mongoose.connection.close();
}

importJobsFromRSS();
