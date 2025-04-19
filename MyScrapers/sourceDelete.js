// deleteLosersJobs.js
const mongoose = require('mongoose');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');

async function deleteJobsWithSourceLosers() {
  await dbConnect();

  try {
    const result = await JobModel.deleteMany({ source: 'eu-rss' });
    console.log(`🗑️ Deleted ${result.deletedCount} jobs with source "eu-rss".`);
  } catch (err) {
    console.error('❌ Error during deletion:', err.message);
  } finally {
    await mongoose.connection.close();
  }
}

deleteJobsWithSourceLosers()