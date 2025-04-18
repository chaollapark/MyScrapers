require('dotenv').config(); // Loads variables from .env

const mongoose = require('mongoose');

async function dbConnect() {
  if (mongoose.connection.readyState >= 1) return;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('❌ MONGODB_URI is missing in your .env file!');
  }

  try {
    await mongoose.connect(uri); // ← Clean and modern
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = dbConnect;
