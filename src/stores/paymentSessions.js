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
      if (data[reference]) return data[reference]

      try {
        const { mongoose, getMongoStatus } = require('../../web/src/db')
        if (getMongoStatus && getMongoStatus()) {
          const doc = await mongoose.connection.db.collection('bot_payment_sessions').findOne({ reference })
          if (doc && doc.session) {
            data[reference] = doc.session
            await writeJsonFileAsync(paymentSessionStorePath, data)
            await syncLocalCache()
            return doc.session
          }
        }
      } catch (e) {}

      return null
    })
  }

  async function updateSession(reference, fn) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(paymentSessionStorePath, {})
      let session = data[reference]

      if (!session) {
        try {
          const { mongoose, getMongoStatus } = require('../../web/src/db')
          if (getMongoStatus && getMongoStatus()) {
            const doc = await mongoose.connection.db.collection('bot_payment_sessions').findOne({ reference })
            if (doc && doc.session) session = doc.session
          }
        } catch (e) {}
      }

      if (session) {
        const updated = await fn(session)
        if (updated !== undefined) {
          data[reference] = updated
        }
        await writeJsonFileAsync(paymentSessionStorePath, data)
        await syncLocalCache()

        try {
          const { mongoose, getMongoStatus } = require('../../web/src/db')
          if (getMongoStatus && getMongoStatus()) {
            await mongoose.connection.db.collection('bot_payment_sessions').updateOne(
              { reference },
              { $set: { reference, session: data[reference], updatedAt: new Date() } },
              { upsert: true }
            ).catch(() => {})
          }
        } catch (e) {}
      }
    })
  }

  async function forgetSession(reference) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(paymentSessionStorePath, {})
      delete data[reference]
      await writeJsonFileAsync(paymentSessionStorePath, data)
      await syncLocalCache()

      try {
        const { mongoose, getMongoStatus } = require('../../web/src/db')
        if (getMongoStatus && getMongoStatus()) {
          await mongoose.connection.db.collection('bot_payment_sessions').deleteOne({ reference }).catch(() => {})
        }
      } catch (e) {}
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

      try {
        const { mongoose, getMongoStatus } = require('../../web/src/db')
        if (getMongoStatus && getMongoStatus()) {
          await mongoose.connection.db.collection('bot_payment_sessions').updateOne(
            { reference },
            { $set: { reference, session, updatedAt: new Date() } },
            { upsert: true }
          ).catch(() => {})
        }
      } catch (e) {}
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
