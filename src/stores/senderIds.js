const fs = require('fs')

function readJsonFile(filePath, fallback) {

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    return fallback
  }
}

function writeJsonFile(filePath, value) {

  fs.writeFileSync(
    filePath,
    JSON.stringify(value, null, 2)
  )
}

function createSenderIdStore({ senderIdStorePath, pendingSenderIdStorePath }) {

  const verifiedSenderIds = {}
  const pendingSenderIdSessions = {}

  function syncVerifiedSenderIds() {
    const data = readJsonFile(senderIdStorePath, {})
    Object.keys(verifiedSenderIds).forEach(key => delete verifiedSenderIds[key])
    Object.assign(verifiedSenderIds, data)
  }

  function syncPendingSenderIdSessions() {
    const data = readJsonFile(pendingSenderIdStorePath, {})
    Object.keys(pendingSenderIdSessions).forEach(key => delete pendingSenderIdSessions[key])
    Object.assign(pendingSenderIdSessions, data)
  }

  // Initial load
  syncVerifiedSenderIds()
  syncPendingSenderIdSessions()

  // Sync from MongoDB Atlas if available
  try {
    const { mongoose, getMongoStatus } = require('../../web/src/db')
    setTimeout(async () => {
      try {
        if (getMongoStatus && getMongoStatus()) {
          const docs = await mongoose.connection.db.collection('bot_sender_ids').find({}).toArray()
          docs.forEach(doc => {
            if (doc.userId && Array.isArray(doc.senderIds) && doc.senderIds.length > 0) {
              const current = verifiedSenderIds[String(doc.userId)] || []
              const merged = Array.from(new Set([...current, ...doc.senderIds]))
              verifiedSenderIds[String(doc.userId)] = merged
            }
          })
        }
      } catch (err) {}
    }, 1500).unref()
  } catch (e) {}

  function getVerifiedSenderIds(userId) {
    syncVerifiedSenderIds()
    return verifiedSenderIds[String(userId)] || []
  }

  function rememberVerifiedSenderId(userId, senderId) {
    syncVerifiedSenderIds()
    const key = String(userId)
    const current = verifiedSenderIds[key] || []

    if (!current.includes(senderId)) {
      verifiedSenderIds[key] = [...current, senderId]
      writeJsonFile(senderIdStorePath, verifiedSenderIds)
    }

    try {
      const { mongoose, getMongoStatus } = require('../../web/src/db')
      if (getMongoStatus && getMongoStatus()) {
        mongoose.connection.db.collection('bot_sender_ids').updateOne(
          { userId: key },
          { $addToSet: { senderIds: senderId }, $set: { updatedAt: new Date() } },
          { upsert: true }
        ).catch(e => console.warn('[Mongo SenderID Update Error]', e.message))
      }
    } catch (e) {}
  }

  function rememberPendingSenderIdSession(requestId, session) {
    syncPendingSenderIdSessions()
    pendingSenderIdSessions[requestId] = session
    writeJsonFile(pendingSenderIdStorePath, pendingSenderIdSessions)
  }

  function forgetPendingSenderIdSession(requestId) {
    syncPendingSenderIdSessions()
    delete pendingSenderIdSessions[requestId]
    writeJsonFile(pendingSenderIdStorePath, pendingSenderIdSessions)
  }

  return {
    forgetPendingSenderIdSession,
    getVerifiedSenderIds,
    pendingSenderIdSessions,
    rememberPendingSenderIdSession,
    rememberVerifiedSenderId
  }
}

module.exports = {
  createSenderIdStore
}

