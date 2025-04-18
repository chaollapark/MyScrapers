const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Your schema
const dbConnect = require('./dbConnect');

const BASE_URL = 'https://eu-careers.europa.eu';
const START_PATH = '/en/job-opportunities/open-vacancies/ec_vacancies';

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

async function scrapeJobsFromPage(page = 0) {
  const url = `${BASE_URL}${START_PATH}?page=${page}`;
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);

  const jobs = [];

  $('table tbody tr').each((_, row) => {
    const $row = $(row);

    const titleEl = $row.find('td.views-field-title a');
    const title = decode(titleEl.text().trim());
    const relativeLink = titleEl.attr('href');
    const link = BASE_URL + relativeLink;

    const domain = decode($row.find('.views-field-field-epso-domain').text().trim());
    const dg = decode($row.find('.views-field-field-dgnew').text().trim());
    const grade = decode($row.find('.views-field-field-epso-grade').text().trim());
    const location = decode($row.find('.views-field-field-epso-location').text().trim());
    const published = $row.find('.views-field-created time').attr('datetime');
    const deadline = $row.find('.views-field-field-epso-deadline time').attr('datetime');

    jobs.push({
      title,
      link,
      domain,
      dg,
      grade,
      location,
      published,
      deadline,
      relativeLink
    });
  });

  return jobs;
}

async function scrapeAllEPSOJobs() {
  await dbConnect();
  let page = 0;
  let allJobs = [];
  const maxJobs = 100;

  while (allJobs.length < maxJobs) {
    console.log(`🔎 Scraping page ${page + 1}...`);
    const jobs = await scrapeJobsFromPage(page);
    if (jobs.length === 0) break;

    for (const job of jobs) {
      if (allJobs.length >= maxJobs) break;
      allJobs.push(job);
    }

    page++;
  }

  console.log(`📦 Total jobs scraped: ${allJobs.length}`);

  for (const job of allJobs) {
    const exists = await JobModel.findOne({ applyLink: job.link });
    if (exists) {
      console.log(`⚠️ Skipping duplicate: ${job.title}`);
      continue;
    }

    const id = uuidv4();
    const slug = generateSlug(job.title, job.dg || 'European Commission', id);

    let seniority = 'mid-level';
    const lowered = job.title.toLowerCase();
    if (lowered.includes('intern')) seniority = 'intern';
    else if (lowered.includes('junior')) seniority = 'junior';
    else if (lowered.includes('senior')) seniority = 'senior';

    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title: job.title,
      slug,
      description: `Domain: ${job.domain}<br>Grade: ${job.grade}<br>DG: ${job.dg}`,
      companyName: job.dg || 'European Commission',
      sourceAgency: '',
      contractType: '',
      vacancyType: '',
      tags: [job.domain],
      remote: 'no',
      type: 'full-time',
      salary: 0,
      city: job.location,
      country: '',
      state: '',
      applyLink: job.link,
      createdAt: new Date(job.published),
      updatedAt: new Date(),
      expiresOn: new Date(job.deadline || Date.now() + 30 * 86400000),
      seniority,
      plan: 'basic',
      source: 'eu-institution'
    });

    try {
      await newJob.save();
      console.log(`✅ Saved: ${job.title}`);
    } catch (err) {
      console.error(`❌ Failed to save ${job.title}:`, err.message);
    }
  }

  mongoose.connection.close();
}

scrapeAllEPSOJobs()