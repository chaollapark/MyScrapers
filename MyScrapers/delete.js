const mongoose = require('mongoose');
const { JobModel } = require('./Job');
const dbConnect = require('./dbConnect');

async function deleteJobsCreatedOnApril18() {
  await dbConnect();

  // April 18, 2025 — from 00:00:00 to just before April 19
  const start = new Date('2025-04-18T00:00:00Z');
  const end = new Date('2025-04-19T00:00:00Z');

  try {
    const result = await JobModel.deleteMany({
      createdAt: { $gte: start, $lt: end },
    });

    console.log(`🗑️ Deleted ${result.deletedCount} jobs created on April 18.`);
  } catch (err) {
    console.error('❌ Error during deletion:', err.message);
  } finally {
    mongoose.connection.close();
  }
}

deleteJobsCreatedOnApril18();
