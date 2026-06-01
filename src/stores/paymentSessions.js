const fs = require('fs').promises
const path = require('path')
const { withLock } = require('../lockManager')

const lockName = 'payment_sessions_json'

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

function createPaymentSessionStore({ paymentSessionStorePath }) {
  // We keep a local cache object just for backwards compatibility with tests that assert on store.paymentSessions
  const paymentSessions = {}

  // Synchronize local cache with disk (used for test compatibility)
  async function syncLocalCache() {
    const data = await readJsonFileAsync(paymentSessionStorePath, {})
    // Clear and copy
    Object.keys(paymentSessions).forEach(key => delete paymentSessions[key])
    Object.assign(paymentSessions, data)
  }

  async function getSession(reference) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(paymentSessionStorePath, {})
      return data[reference] || null
    })
  }

  async function updateSession(reference, fn) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(paymentSessionStorePath, {})
      const session = data[reference]
      if (session) {
        const updated = await fn(session)
        if (updated !== undefined) {
          data[reference] = updated
        }
        await writeJsonFileAsync(paymentSessionStorePath, data)
        await syncLocalCache()
      }
    })
  }

  async function forgetSession(reference) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(paymentSessionStorePath, {})
      delete data[reference]
      await writeJsonFileAsync(paymentSessionStorePath, data)
      await syncLocalCache()
    })
  }

  async function rememberPaymentSession(reference, session) {
    await withLock(lockName, async () => {
      const data = await readJsonFileAsync(paymentSessionStorePath, {})
      if (!session.status) {
        session.status = 'pending'
      }
      data[reference] = session
      await writeJsonFileAsync(paymentSessionStorePath, data)
      await syncLocalCache()
    })
  }

  async function forgetPaymentSession(reference) {
    await forgetSession(reference)
  }

  return {
    forgetPaymentSession,
    paymentSessions, // Plain object reference synchronized with file writes
    rememberPaymentSession,
    getSession,
    updateSession,
    forgetSession
  }
}

module.exports = {
  createPaymentSessionStore
}
