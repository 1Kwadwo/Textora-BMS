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

  async function getDeveloperByApiKey(apiKey) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      return data.api_keys[apiKey] || null
    })
  }

  async function getDeveloperByUserId(userId) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      return data.users[String(userId)] || null
    })
  }

  async function createOrGetDeveloper(userId, name) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      const key = String(userId)
      if (data.users[key]) {
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
      await writeJsonFileAsync(apiDevelopersStorePath, data)
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
      return dev
    })
  }

  async function creditDeveloperBalance(userId, amount) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      const key = String(userId)
      const dev = data.users[key]
      if (!dev) return null
      
      dev.balance = Number((dev.balance + Number(amount)).toFixed(2))
      data.api_keys[dev.apiKey].balance = dev.balance
      await writeJsonFileAsync(apiDevelopersStorePath, data)
      return dev
    })
  }

  async function debitDeveloperBalance(apiKey, amount) {
    return await withLock(lockName, async () => {
      const data = await readJsonFileAsync(apiDevelopersStorePath, { api_keys: {}, users: {} })
      const dev = data.api_keys[apiKey]
      if (!dev) {
        return { ok: false, message: 'Developer not found' }
      }
      if (dev.balance < amount) {
        return { ok: false, balance: dev.balance, message: 'Insufficient prepaid credits' }
      }
      dev.balance = Number((dev.balance - Number(amount)).toFixed(2))
      data.users[dev.userId].balance = dev.balance
      await writeJsonFileAsync(apiDevelopersStorePath, data)
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
