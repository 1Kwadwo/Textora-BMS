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

  async function getMongoDb() {
    try {
      const path = require('path')
      const dbPath = path.resolve(__dirname, '../../web/src/db')
      const { mongoose, connectDB, getMongoStatus } = require(dbPath)
      if (!getMongoStatus || !getMongoStatus() || mongoose.connection?.readyState !== 1) {
        await connectDB().catch(e => console.warn('[apiDevelopers getMongoDb connectDB warn]', e.message))
      }
      return mongoose.connection.db || mongoose.connection.client?.db() || null
    } catch (e) {
      console.warn('[apiDevelopers getMongoDb catch]', e.message)
    }
    return null
  }

  async function getDeveloperByApiKey(apiKey) {
    return await withLock(lockName, async () => {
      const db = await getMongoDb()
      if (db) {
        try {
          const dev = await db.collection('bot_api_developers').findOne({
            $or: [{ apiKey }, { apiKeys: apiKey }]
          })
          if (dev) {
            return dev
          }
          // Also check web apikeys collection if someone used their web key on the bot gateway
          const keyDoc = await db.collection('apikeys').findOne({ key: apiKey })
          if (keyDoc) {
            const userDoc = await db.collection('users').findOne({ _id: keyDoc.userId })
            if (userDoc) {
              return {
                userId: String(userDoc._id),
                apiKey,
                balance: userDoc.balance || 0,
                name: userDoc.name,
                isWebUser: true
              }
            }
          }
        } catch (e) {}
      }

      // Offline / local fallback
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      return data.api_keys ? data.api_keys[apiKey] || null : null
    })
  }

  async function getDeveloperByUserId(userId) {
    return await withLock(lockName, async () => {
      const key = String(userId)
      const db = await getMongoDb()
      if (db) {
        try {
          const dev = await db.collection('bot_api_developers').findOne({ userId: key })
          if (dev) {
            return dev
          }
        } catch (e) {}
      }

      // Offline / local fallback
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      return data.users ? data.users[key] || null : null
    })
  }

  async function createOrGetDeveloper(userId, name) {
    return await withLock(lockName, async () => {
      const key = String(userId)
      const db = await getMongoDb()
      if (db) {
        try {
          const existing = await db.collection('bot_api_developers').findOne({ userId: key })
          if (existing) {
            return existing
          }
        } catch (e) {}
      }

      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      if (data.users && data.users[key]) {
        return data.users[key]
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
      await writeJsonFileAsync(apiDevelopersStorePath, data).catch(() => {})

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
      const key = String(userId)
      let dev = null
      const db = await getMongoDb()
      if (db) {
        try {
          dev = await db.collection('bot_api_developers').findOne({ userId: key })
        } catch (e) {}
      }

      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      if (!dev && data.users && data.users[key]) {
        dev = data.users[key]
      }
      if (!dev) return null
      
      const newApiKey = 'txt_' + crypto.randomBytes(24).toString('hex')
      dev.apiKey = newApiKey
      
      if (data.api_keys) {
        data.api_keys[newApiKey] = dev
        await writeJsonFileAsync(apiDevelopersStorePath, data).catch(() => {})
      }

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
      const key = String(userId)
      let dev = null
      const db = await getMongoDb()

      if (db) {
        try {
          dev = await db.collection('bot_api_developers').findOne({ userId: key })
        } catch (e) {}
      }

      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      if (!dev && data.users && data.users[key]) {
        dev = data.users[key]
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
      if (data.users) {
        data.users[key] = dev
        if (dev.apiKey) data.api_keys[dev.apiKey] = dev
        await writeJsonFileAsync(apiDevelopersStorePath, data).catch(() => {})
      }

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
      const db = await getMongoDb()

      if (!dev && db) {
        try {
          dev = await db.collection('bot_api_developers').findOne({
            $or: [{ apiKey }, { apiKeys: apiKey }]
          })
        } catch (e) {}
      }

      if (!dev && db) {
        try {
          // Check web apikeys
          const keyDoc = await db.collection('apikeys').findOne({ key: apiKey })
          if (keyDoc) {
            const userDoc = await db.collection('users').findOne({ _id: keyDoc.userId })
            if (userDoc) {
              dev = {
                userId: String(userDoc._id),
                apiKey,
                balance: userDoc.balance || 0,
                name: userDoc.name,
                isWebUser: true
              }
            }
          }
        } catch (e) {}
      }

      if (!dev) {
        return { ok: false, message: 'Developer not found' }
      }
      if (dev.balance < amount) {
        return { ok: false, balance: dev.balance, message: 'Insufficient prepaid credits' }
      }

      if (dev.isWebUser && db) {
        try {
          const { ObjectId } = require('mongodb')
          await db.collection('users').updateOne(
            { _id: new ObjectId(dev.userId) },
            { $inc: { balance: -amount } }
          )
          return { ok: true, balance: Number((dev.balance - amount).toFixed(2)) }
        } catch (e) {}
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
