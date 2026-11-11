const mongoose = require('mongoose')
const path = require('path')
const fs = require('fs')

let isMongoConnected = false
let connectionPromise = null
let lastMongoError = null

// Accept the common spellings people type into hosting dashboards. Keys are
// trimmed because a stray space in the Render key name makes it invisible.
const MONGO_KEYS = ['MONGODB_URI', 'MONGO_URI', 'MONGODB_URL', 'MONGO_URL', 'DATABASE_URL']
function getMongoUri() {
  for (const want of MONGO_KEYS) {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.trim().toUpperCase() === want && v && String(v).trim().startsWith('mongodb')) return String(v).trim()
    }
  }
  return ''
}

async function connectDB() {
  if (mongoose.connection?.readyState === 1) {
    isMongoConnected = true
    return true
  }

  if (connectionPromise) {
    return connectionPromise
  }

  const uri = getMongoUri()

  if (!uri) {
    const similar = Object.keys(process.env).filter(k => /mongo|database/i.test(k))
    lastMongoError = 'No MONGODB_URI in process.env' + (similar.length ? ` (found similar keys: ${similar.join(', ')})` : ' (no Mongo-like keys set at all)')
    console.log('[Database] No MONGODB_URI provided in environment. Running in local memory/file-backed mode.')
    return false
  }

  connectionPromise = (async () => {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000
      })
      isMongoConnected = true
      lastMongoError = null
      console.log('[Database] 🚀 Connected to MongoDB successfully.')
      return true
    } catch (err) {
      lastMongoError = err.message
      console.warn(`[Database] MongoDB connection error (${err.message}). Using local store fallback.`)
      isMongoConnected = false
      return false
    } finally {
      connectionPromise = null
    }
  })()

  return connectionPromise
}

function getMongoError() {
  return lastMongoError
}

mongoose.connection.on('disconnected', () => {
  isMongoConnected = false
  console.warn('[Database] MongoDB connection lost. Will reconnect on next request.')
})

function getMongoStatus() {
  return isMongoConnected || mongoose.connection?.readyState === 1
}

module.exports = {
  getMongoUri,
  connectDB,
  getMongoStatus,
  getMongoError,
  mongoose
}
