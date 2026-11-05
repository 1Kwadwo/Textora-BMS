const mongoose = require('mongoose')
const path = require('path')
const fs = require('fs')

let isMongoConnected = false
let connectionPromise = null

async function connectDB() {
  if (mongoose.connection?.readyState === 1) {
    isMongoConnected = true
    return true
  }

  if (connectionPromise) {
    return connectionPromise
  }

  const FALLBACK_MONGODB_URI = 'mongodb+srv://harrisbraimah_db_user:KI5QPHz693cr7UUs@cluster0.xat7u5f.mongodb.net/textora?retryWrites=true&w=majority'
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || FALLBACK_MONGODB_URI

  if (!uri) {
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
      console.log('[Database] 🚀 Connected to MongoDB successfully.')
      return true
    } catch (err) {
      console.warn(`[Database] MongoDB connection error (${err.message}). Using local store fallback.`)
      isMongoConnected = false
      return false
    } finally {
      connectionPromise = null
    }
  })()

  return connectionPromise
}

mongoose.connection.on('disconnected', () => {
  isMongoConnected = false
  console.warn('[Database] MongoDB connection lost. Will reconnect on next request.')
})

function getMongoStatus() {
  return isMongoConnected || mongoose.connection?.readyState === 1
}

module.exports = {
  connectDB,
  getMongoStatus,
  mongoose
}
