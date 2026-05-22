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

  const verifiedSenderIds =
    readJsonFile(senderIdStorePath, {})

  const pendingSenderIdSessions =
    readJsonFile(pendingSenderIdStorePath, {})

  function saveVerifiedSenderIds() {

    writeJsonFile(senderIdStorePath, verifiedSenderIds)
  }

  function getVerifiedSenderIds(userId) {

    return verifiedSenderIds[String(userId)] || []
  }

  function rememberVerifiedSenderId(userId, senderId) {

    const key =
      String(userId)

    const current =
      verifiedSenderIds[key] || []

    if (!current.includes(senderId)) {
      verifiedSenderIds[key] = [...current, senderId]
      saveVerifiedSenderIds()
    }
  }

  function savePendingSenderIdSessions() {

    writeJsonFile(pendingSenderIdStorePath, pendingSenderIdSessions)
  }

  function rememberPendingSenderIdSession(requestId, session) {

    pendingSenderIdSessions[requestId] = session
    savePendingSenderIdSessions()
  }

  function forgetPendingSenderIdSession(requestId) {

    delete pendingSenderIdSessions[requestId]
    savePendingSenderIdSessions()
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
