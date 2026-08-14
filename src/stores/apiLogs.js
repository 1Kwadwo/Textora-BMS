const fs = require('fs').promises
const { withLock } = require('../lockManager')

const lockName = 'api_usage_log_json'

async function readJsonFileAsync(filePath, fallback) {
  try {
    const data = await fs.readFile(filePath, 'utf8')
    return JSON.parse(data)
  } catch (err) {
    return fallback
  }
}

async function writeJsonFileAsync(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function createApiLogsStore({ apiLogsPath }) {
  async function logApiUsage(userId, details) {
    return await withLock(lockName, async () => {
      const logs = await readJsonFileAsync(apiLogsPath, [])
      const newLog = {
        userId: String(userId),
        timestamp: new Date().toISOString(),
        message: details.message,
        recipientsCount: details.recipientsCount,
        unitsDebited: details.unitsDebited,
        remainingBalance: details.remainingBalance,
        status: details.status || 'success'
      }
      logs.push(newLog)
      await writeJsonFileAsync(apiLogsPath, logs)
      return newLog
    })
  }

  async function getApiUsageLogs(userId) {
    return await withLock(lockName, async () => {
      const logs = await readJsonFileAsync(apiLogsPath, [])
      return logs.filter(log => log.userId === String(userId))
    })
  }

  return {
    logApiUsage,
    getApiUsageLogs
  }
}

module.exports = {
  createApiLogsStore
}
