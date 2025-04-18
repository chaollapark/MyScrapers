const mongoose = require('mongoose');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { JobModel } = require('./Job'); // Your existing Job model
const dbConnect = require('./dbConnect'); // Your MongoDB connection

const STORYBLOK_TOKEN = 'Tm0AEdGfJUmWBJcbrVXC7gtt';
const BASE_LIST_URL = 'https://api.storyblok.com/v1/cdn/stories';
const BASE_DETAIL_URL = 'https://api.storyblok.com/v1/cdn/stories';

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

async function getFirst3JobUUIDs() {
  const res = await axios.get(BASE_LIST_URL, {
    params: {
      token: STORYBLOK_TOKEN,
      starts_with: 'jobs/',
      per_page: 100,
    },
  });

  return res.data.stories || [];
}

async function getJobDetails(uuid) {
  const res = await axios.get(`${BASE_DETAIL_URL}/${uuid}`, {
    params: {
      token: STORYBLOK_TOKEN,
      find_by: 'uuid',
    },
  });

  return res.data.story.content;
}

function extractTextFromStoryblok(desc) {
    if (!desc || typeof desc !== 'object') return '';
    if (!Array.isArray(desc.content)) return '';
  
    return desc.content
      .map((block) => {
        if (block.type === 'paragraph' || block.type === 'heading') {
          return block.content?.map(c => c.text).join(' ') || '';
        }
        if (block.type === 'bullet_list') {
          return block.content
            ?.map(item =>
              item.content?.map(i => i.content?.map(c => c.text).join(' ')).join(' ')
            )
            .join('\n• ');
        }
        return '';
      })
      .join('\n\n');
  }

  
async function scrapeStoryblokJobs() {
  await dbConnect();

  const stories = await getFirst3JobUUIDs();
  console.log(`🔍 Found ${stories.length} jobs...`);

  for (const story of stories) {
    const fullJob = await getJobDetails(story.uuid);

    const title = fullJob.title || story.name || 'Untitled';
    const companyName =
      fullJob.company ||
      fullJob.org ||
      fullJob.meta?.company ||
      fullJob.author ||
      fullJob.created_by ||
      'Unknown org';
    const applyLink =
        (fullJob.link?.url ||
        fullJob.link?.cached_url ||
        fullJob.apply_link?.url ||
        fullJob.apply_link?.cached_url ||
        '').toString();

    const exists = await JobModel.findOne({ applyLink });
    if (exists) {
      console.log(`⚠️ Skipping existing job: ${title}`);
      continue;
    }

    const id = uuidv4();
    const slug = generateSlug(title, companyName, id);
    const deadline = new Date(fullJob.deadline || Date.now() + 30 * 86400000);
    const createdAt = new Date(story.created_at || Date.now());

    let seniority = 'mid-level';
    const lowered = title.toLowerCase();
    if (lowered.includes('intern')) seniority = 'intern';
    else if (lowered.includes('junior')) seniority = 'junior';
    else if (lowered.includes('senior')) seniority = 'senior';

    const newJob = new JobModel({
      _id: new mongoose.Types.ObjectId(),
      title,
      slug,
      description: extractTextFromStoryblok(fullJob.description || fullJob.body),
      companyName,
      sourceAgency: '',
      contractType: fullJob.contract || '',
      vacancyType: '',
      tags: fullJob.tags || [],
      remote: 'no',
      type: 'full-time',
      salary: 0,
      city: fullJob.location || '',
      country: '',
      state: '',
      applyLink,
      createdAt,
      updatedAt: new Date(),
      expiresOn: deadline,
      seniority,
      plan: 'basic',
      source: "jobsin",
    });

    try {
      await newJob.save();
      console.log(`✅ Saved: ${title}`);
    } catch (err) {
      console.error(`❌ Failed to save ${title}:`, err.message);
    }
  }

  mongoose.connection.close();
}

scrapeStoryblokJobs();
