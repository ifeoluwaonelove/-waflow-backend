'use strict';
const mongoose = require('mongoose');

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 5000;

async function connectDB(retries = 0) {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('[DB] MONGODB_URI environment variable is not set');
  }

  const options = {
    maxPoolSize: 10,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    heartbeatFrequencyMS: 10000,
    retryWrites: true,
    w: 'majority',
  };

  try {
    await mongoose.connect(uri, options);
    const dbName = mongoose.connection.db.databaseName;
    console.log(`[DB] Connected to MongoDB — database: ${dbName}`);

    mongoose.connection.on('disconnected', () => {
      console.warn('[DB] MongoDB disconnected — attempting reconnect...');
      setTimeout(() => connectDB(), RETRY_DELAY_MS);
    });

    mongoose.connection.on('error', (err) => {
      console.error('[DB] MongoDB connection error:', err.message);
    });

    return mongoose.connection;
  } catch (err) {
    console.error(`[DB] Connection failed (attempt ${retries + 1}/${MAX_RETRIES}):`, err.message);

    if (retries < MAX_RETRIES) {
      console.log(`[DB] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return connectDB(retries + 1);
    }

    throw new Error(`[DB] Could not connect after ${MAX_RETRIES} attempts: ${err.message}`);
  }
}

module.exports = connectDB;
