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

