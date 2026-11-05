const mongoose = require('mongoose')
const path = require('path')
const fs = require('fs')

let isMongoConnected = false
let connectionPromise = null
let lastMongoError = null

async function connectDB() {
  if (mongoose.connection?.readyState === 1) {
    isMongoConnected = true
    return true
  }

  if (connectionPromise) {
    return connectionPromise
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI

  if (!uri) {
    lastMongoError = 'No MONGODB_URI or MONGO_URI in process.env'
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
  connectDB,
  getMongoStatus,
  getMongoError,
  mongoose
}
