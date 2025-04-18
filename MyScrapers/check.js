const fs = require('fs');
const axios = require('axios');

const STORYBLOK_TOKEN = 'Tm0AEdGfJUmWBJcbrVXC7gtt';
const BASE_LIST_URL = 'https://api.storyblok.com/v1/cdn/stories';
const BASE_DETAIL_URL = 'https://api.storyblok.com/v1/cdn/stories';

async function getJobUUIDs(limit = 10) {
  const res = await axios.get(BASE_LIST_URL, {
    params: {
      token: STORYBLOK_TOKEN,
      starts_with: 'jobs/',
      per_page: limit,
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
  return res.data.story; // this includes both .content and metadata
}

async function dumpFirst10Jobs() {
  try {
    const jobs = await getJobUUIDs(10);

    for (const job of jobs) {
      const fullJob = await getJobDetails(job.uuid);
      const filename = `storyblok-job-${job.uuid}.json`;
      fs.writeFileSync(filename, JSON.stringify(fullJob, null, 2));
      console.log(`💾 Saved ${filename}`);
    }
  } catch (err) {
    console.error('❌ Error dumping jobs:', err.message);
  }
}

dumpFirst10Jobs();
