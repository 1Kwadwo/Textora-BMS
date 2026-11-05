const fs = require('fs').promises
const crypto = require('crypto')
const { withLock } = require('../lockManager')

const lockName = 'api_developers_json'

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

function createApiDevelopersStore({ apiDevelopersStorePath }) {

  function getMongoDb() {
    try {
      const { mongoose, getMongoStatus } = require('../../web/src/db')
      if (getMongoStatus && getMongoStatus() && mongoose.connection?.db) {
        return mongoose.connection.db
      }
    } catch (e) {}
    return null
  }

  async function getDeveloperByApiKey(apiKey) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      if (data.api_keys && data.api_keys[apiKey]) {
        return data.api_keys[apiKey]
      }
      const db = getMongoDb()
      if (db) {
        try {
          const dev = await db.collection('bot_api_developers').findOne({ apiKey })
          if (dev) {
            data.api_keys[apiKey] = dev
            data.users[String(dev.userId)] = dev
            await writeJsonFileAsync(apiDevelopersStorePath, data).catch(() => {})
            return dev
          }
        } catch (e) {}
      }
      return null
    })
  }

  async function getDeveloperByUserId(userId) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      const key = String(userId)
      if (data.users && data.users[key]) {
        return data.users[key]
      }
      const db = getMongoDb()
      if (db) {
        try {
          const dev = await db.collection('bot_api_developers').findOne({ userId: key })
          if (dev) {
            data.users[key] = dev
            if (dev.apiKey) data.api_keys[dev.apiKey] = dev
            await writeJsonFileAsync(apiDevelopersStorePath, data).catch(() => {})
            return dev
          }
        } catch (e) {}
      }
      return null
    })
  }

  async function createOrGetDeveloper(userId, name) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      const key = String(userId)
      if (data.users && data.users[key]) {
        return data.users[key]
      }
      const db = getMongoDb()
      if (db) {
        try {
          const existing = await db.collection('bot_api_developers').findOne({ userId: key })
          if (existing) {
            data.users[key] = existing
            data.api_keys[existing.apiKey] = existing
            await writeJsonFileAsync(apiDevelopersStorePath, data).catch(() => {})
            return existing
          }
        } catch (e) {}
      }

      const apiKey = 'txt_' + crypto.randomBytes(24).toString('hex')
      const dev = {
        userId: key,
        apiKey,
        balance: 0,
        name: name || 'Developer'
      }
      data.users[key] = dev
      data.api_keys[apiKey] = dev
      await writeJsonFileAsync(apiDevelopersStorePath, data)

      if (db) {
        try {
          await db.collection('bot_api_developers').updateOne(
            { userId: key },
            { $set: dev },
            { upsert: true }
          )
        } catch (e) {}
      }

      return dev
    })
  }

  async function regenerateApiKey(userId) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      const key = String(userId)
      const dev = data.users[key]
      if (!dev) return null
      
      // Remove old key mapping
      delete data.api_keys[dev.apiKey]
      
      const newApiKey = 'txt_' + crypto.randomBytes(24).toString('hex')
      dev.apiKey = newApiKey
      data.api_keys[newApiKey] = dev
      await writeJsonFileAsync(apiDevelopersStorePath, data)

      const db = getMongoDb()
      if (db) {
        try {
          await db.collection('bot_api_developers').updateOne(
            { userId: key },
            { $set: { apiKey: newApiKey, updatedAt: new Date() } }
          )
        } catch (e) {}
      }

      return dev
    })
  }

  async function creditDeveloperBalance(userId, amount, name = 'Developer') {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      if (!data.users) data.users = {}
      if (!data.api_keys) data.api_keys = {}
      const key = String(userId)
      let dev = data.users[key]
      const db = getMongoDb()

      if (!dev && db) {
        try {
          dev = await db.collection('bot_api_developers').findOne({ userId: key })
        } catch (e) {}
      }

      if (!dev) {
        const apiKey = 'txt_' + crypto.randomBytes(24).toString('hex')
        dev = {
          userId: key,
          apiKey,
          balance: 0,
          name: name || 'Developer'
        }
      }
      
      dev.balance = Number((Number(dev.balance || 0) + Number(amount)).toFixed(2))
      data.users[key] = dev
      if (dev.apiKey) {
        data.api_keys[dev.apiKey] = dev
      }
      await writeJsonFileAsync(apiDevelopersStorePath, data)

      if (db) {
        try {
          await db.collection('bot_api_developers').updateOne(
            { userId: key },
            { $set: { balance: dev.balance, apiKey: dev.apiKey, name: dev.name, updatedAt: new Date() } },
            { upsert: true }
          )
        } catch (e) {}
      }

      return dev
    })
  }

  async function debitDeveloperBalance(apiKey, amount) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      let dev = data.api_keys[apiKey]
      const db = getMongoDb()

      if (!dev && db) {
        try {
          dev = await db.collection('bot_api_developers').findOne({ apiKey })
        } catch (e) {}
      }

      if (!dev) {
        return { ok: false, message: 'Developer not found' }
      }
      if (dev.balance < amount) {
        return { ok: false, balance: dev.balance, message: 'Insufficient prepaid credits' }
      }
      dev.balance = Number((dev.balance - Number(amount)).toFixed(2))
      data.users[dev.userId] = dev
      data.api_keys[apiKey] = dev
      await writeJsonFileAsync(apiDevelopersStorePath, data)

      if (db) {
        try {
          await db.collection('bot_api_developers').updateOne(
            { userId: String(dev.userId) },
            { $set: { balance: dev.balance, updatedAt: new Date() } }
          )
        } catch (e) {}
      }

      return { ok: true, balance: dev.balance }
    })
  }

  return {
    getDeveloperByApiKey,
    getDeveloperByUserId,
    createOrGetDeveloper,
    regenerateApiKey,
    creditDeveloperBalance,
    debitDeveloperBalance
  }
}

module.exports = {
  createApiDevelopersStore
}
