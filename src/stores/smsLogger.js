const fs = require('fs').promises
const path = require('path')
const { withLock } = require('../lockManager')

const smsLogPath = path.join(__dirname, '..', 'sms-log.json')
const lockName = 'sms_log_json'

async function readSmsLog() {
  try {
    const data = await fs.readFile(smsLogPath, 'utf8')
    return JSON.parse(data)
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {}
    }
    console.log('Error reading sms-log.json:', err.message)
    return {}
  }
}

async function writeSmsLog(log) {
  await fs.writeFile(smsLogPath, JSON.stringify(log, null, 2), 'utf8')
}

async function getSmsLogStatus(reference, phone) {
  return await withLock(lockName, async () => {
    const log = await readSmsLog()
    const key = `${reference}:${phone}`
    return log[key] || null
  })
}

async function reserveSmsLog(reference, phone) {
  return await withLock(lockName, async () => {
    const log = await readSmsLog()
    const key = `${reference}:${phone}`
    log[key] = {
      status: 'reserved',
      timestamp: Date.now()
    }
    await writeSmsLog(log)
  })
}

async function markSmsLogSent(reference, phone) {
  return await withLock(lockName, async () => {
    const log = await readSmsLog()
    const key = `${reference}:${phone}`
    log[key] = {
      status: 'sent',
      timestamp: Date.now()
    }
    await writeSmsLog(log)
  })
}

async function markSmsLogFailed(reference, phone) {
  return await withLock(lockName, async () => {
    const log = await readSmsLog()
    const key = `${reference}:${phone}`
    log[key] = {
      status: 'failed',
      timestamp: Date.now()
    }
    await writeSmsLog(log)
  })
}

module.exports = {
  getSmsLogStatus,
  reserveSmsLog,
  markSmsLogSent,
  markSmsLogFailed
}
