const mongoose = require('mongoose')
const path = require('path')
const fs = require('fs')

let isMongoConnected = false

async function connectDB() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI

  if (!uri) {
    console.log('[Database] No MONGODB_URI provided in environment. Running in local memory/file-backed mode.')
    return false
  }

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 4000
    })
    isMongoConnected = true
    console.log('[Database] 🚀 Connected to MongoDB successfully.')
    return true
  } catch (err) {
    console.warn(`[Database] MongoDB connection error (${err.message}). Using local store fallback.`)
    isMongoConnected = false
    return false
  }
}

function getMongoStatus() {
  return isMongoConnected || mongoose.connection?.readyState === 1
}

module.exports = {
  connectDB,
  getMongoStatus,
  mongoose
}
