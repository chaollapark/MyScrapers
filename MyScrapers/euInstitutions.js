const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Make sure your schema includes relativeLink
const dbConnect = require('./dbConnect');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');

const BASE_URL = 'https://eu-careers.europa.eu';
const START_PATH = '/en/job-opportunities/open-vacancies/ec_vacancies';

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 2000; // 2 seconds between requests
const MAX_RETRIES = 3; // Maximum number of retries on failure

/**
 * Sleep function to pause execution
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after ms milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

async function scrapeJobsFromPage(page = 0) {
  const url = `${BASE_URL}${START_PATH}?page=${page}`;
  
  // Implement retry logic with exponential backoff
  let retries = 0;
  let res;
  
  while (retries <= MAX_RETRIES) {
    try {
      // Add custom headers to mimic a real browser
      res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        },
        timeout: 30000 // 30 seconds timeout
      });
      
      // If we get here, request was successful
      break;
    } catch (error) {
      retries++;
      
      // Check if we've reached the max retries
      if (retries > MAX_RETRIES) {
        console.error(`❌ Failed to fetch page ${page} after ${MAX_RETRIES} attempts: ${error.message}`);
        throw error;
      }
      
      // Calculate backoff time - increases with each retry (exponential backoff)
      const backoffTime = DELAY_BETWEEN_REQUESTS * Math.pow(2, retries - 1);
      console.log(`⚠️ Rate limited or error on page ${page}, retry ${retries}/${MAX_RETRIES} after ${backoffTime/1000}s: ${error.message}`);
      
      // Wait before retrying
      await sleep(backoffTime);
    }
  }
  
  const $ = cheerio.load(res.data);

  const jobs = [];

  $('table tbody tr').each((_, row) => {
    const $row = $(row);

    const titleEl = $row.find('td.views-field-title a');
    const title = decode(titleEl.text().trim());
    const rawLink = titleEl.attr('href');
    const relativeLink = normalizeLink(rawLink);
    const link = BASE_URL + relativeLink;

    const domain = decode($row.find('.views-field-field-epso-domain').text().trim());
    const dg = decode($row.find('.views-field-field-dgnew').text().trim());
    const grade = decode($row.find('.views-field-field-epso-grade').text().trim());
    const location = decode($row.find('.views-field-field-epso-location').text().trim());
    const published = $row.find('.views-field-created time').attr('datetime');
    const deadline = $row.find('.views-field-field-epso-deadline time').attr('datetime');

    jobs.push({
      title,
      relativeLink,
      link,
      domain,
      dg,
      grade,
      location,
      published,
      deadline
    });
  });

  return jobs;
}

/**
 * Extract text content from DOCX or PDF document
 * @param {string} documentUrl - URL of the document to extract
 * @returns {Promise<string>} - Extracted text content
 */
async function extractDocumentContent(documentUrl) {
  try {
    const response = await axios.get(documentUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 30000
    });
    
    let content = '';
    
    if (documentUrl.endsWith('.docx')) {
      const result = await mammoth.extractRawText({ buffer: response.data });
      content = result.value;
    } else if (documentUrl.endsWith('.pdf')) {
      const data = await pdf(response.data);
      content = data.text;
    }
    
    return content.trim();
  } catch (error) {
    console.error(`❌ Failed to extract document ${documentUrl}:`, error.message);
    return '';
  }
}

/**
 * Scrape individual job page to get detailed description and application links
 * @param {string} jobUrl - Full URL of the job page
 * @returns {Promise<Object>} - Object containing description and apply link
 */
async function scrapeJobDetails(jobUrl) {
  let retries = 0;
  
  while (retries <= MAX_RETRIES) {
    try {
      const response = await axios.get(jobUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache'
        },
        timeout: 30000
      });
      
      const $ = cheerio.load(response.data);
      
      // Look for document links
      const docLinks = [];
      const appLinks = [];
      
      $('a[href$=".docx"], a[href$=".pdf"]').each((_, link) => {
        const href = $(link).attr('href');
        const text = $(link).text().trim();
        
        if (href) {
          const fullUrl = href.startsWith('http') ? href : BASE_URL + href;
          
          if (text.toLowerCase().includes('application') || 
              text.toLowerCase().includes('form') ||
              text.toLowerCase().includes('single application')) {
            appLinks.push({ url: fullUrl, text });
          } else if (text.toLowerCase().includes('vn.') || 
                     text.toLowerCase().includes('vacancy') ||
                     href.includes('eu_vacancies')) {
            docLinks.push({ url: fullUrl, text });
          }
        }
      });
      
      // Extract description from the first job description document
      let description = '';
      if (docLinks.length > 0) {
        console.log(`📄 Extracting description from: ${docLinks[0].text}`);
        description = await extractDocumentContent(docLinks[0].url);
        
        // If extraction failed or content is too short, try other documents
        if (!description || description.length < 100) {
          for (let i = 1; i < docLinks.length; i++) {
            console.log(`📄 Trying alternative document: ${docLinks[i].text}`);
            description = await extractDocumentContent(docLinks[i].url);
            if (description && description.length >= 100) break;
          }
        }
      }
      
      // Get apply link (prefer application form documents)
      let applyLink = jobUrl; // Default to job page URL
      if (appLinks.length > 0) {
        applyLink = appLinks[0].url;
        console.log(`📝 Using application form: ${appLinks[0].text}`);
      }
      
      return {
        description: description || 'No detailed description available',
        applyLink,
        hasDocument: docLinks.length > 0,
        hasApplicationForm: appLinks.length > 0
      };
      
    } catch (error) {
      retries++;
      
      if (retries > MAX_RETRIES) {
        console.error(`❌ Failed to scrape job details for ${jobUrl} after ${MAX_RETRIES} attempts: ${error.message}`);
        return {
          description: 'Failed to extract description',
          applyLink: jobUrl,
          hasDocument: false,
          hasApplicationForm: false
        };
      }
      
      const backoffTime = DELAY_BETWEEN_REQUESTS * Math.pow(2, retries - 1);
      console.log(`⚠️ Error scraping job details, retry ${retries}/${MAX_RETRIES} after ${backoffTime/1000}s: ${error.message}`);
      await sleep(backoffTime);
    }
  }
}

async function scrapeAllEPSOJobs() {
  await dbConnect();
  let page = 0;
  let allJobs = [];
  const maxJobs = 100;
  let jobsScraped = 0;

  console.log("\n🚀 Starting EU Institutions Jobs scraper...\n");

  while (allJobs.length < maxJobs) {
    console.log(`🔍 Scraping page ${page + 1}...`);
    
    try {
      const jobs = await scrapeJobsFromPage(page);
      
      if (jobs.length === 0) {
        console.log(`✅ No more jobs found. Finishing scraping.`);
        break;
      }

      // Add jobs to our collection
      for (const job of jobs) {
        if (allJobs.length >= maxJobs) break;
        allJobs.push(job);
        jobsScraped++;
      }
      
      console.log(`💾 Found ${jobs.length} jobs on page ${page + 1}. Total so far: ${jobsScraped}`);
      
      // Wait between page scrapes to avoid rate limiting
      if (allJobs.length < maxJobs) {
        const waitTime = DELAY_BETWEEN_REQUESTS;
        console.log(`⏳ Waiting ${waitTime/1000} seconds before next page...`);
        await sleep(waitTime);
      }

      page++;
    } catch (error) {
      console.error(`❌ Error scraping page ${page + 1}: ${error.message}`);
      console.log(`🛠 Continuing with jobs collected so far: ${allJobs.length}`);
      break;
    }
  }

  console.log(`📦 Total jobs scraped: ${allJobs.length}`);

  for (const job of allJobs) {
    const exists = await JobModel.findOne({ relativeLink: job.relativeLink });
    if (exists) {
      console.log(`⚠️ Skipping duplicate: ${job.relativeLink}`);
      continue;
    }

    const id = uuidv4();
    const slug = generateSlug(job.title, job.dg || 'European Commission', id);

    let seniority = 'mid-level';
    const lowered = job.title.toLowerCase();
    if (lowered.includes('intern')) seniority = 'intern';
    else if (lowered.includes('junior')) seniority = 'junior';
    else if (lowered.includes('senior')) seniority = 'senior';

    const jobDetails = await scrapeJobDetails(job.link);
    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title: job.title,
      slug,
      description: jobDetails.description,
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
      applyLink: jobDetails.applyLink,
      relativeLink: job.relativeLink, // ✅ standardized dedupe key
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
      if (err.code === 11000) {
        console.log(`⚠️ Duplicate caught by DB index: ${job.relativeLink}`);
      } else {
        console.error(`❌ Failed to save ${job.title}:`, err.message);
      }
    }
  }

  mongoose.connection.close();
}

scrapeAllEPSOJobs();
