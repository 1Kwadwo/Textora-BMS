// Small document store for the email module.
// Uses the shared MongoDB connection when it is up (collections prefixed
// `email_`), and falls back to data/email-store.json otherwise, the same way
// the existing web repos fall back to data/web-store.json.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { mongoose, getMongoStatus } = require('../db')

const STORE_FILE = process.env.EMAIL_STORE_FILE || path.join(__dirname, '../../../data/email-store.json')

let fileCache = null
function fileData() {
  if (fileCache) return fileCache
  try {
    if (fs.existsSync(STORE_FILE)) fileCache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
  } catch (err) {
    console.error('[Email Store] Could not read store file:', err.message)
  }
  if (!fileCache || typeof fileCache !== 'object') fileCache = {}
  return fileCache
}
function fileSave() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true })
    fs.writeFileSync(STORE_FILE, JSON.stringify(fileCache, null, 2), 'utf8')
  } catch (err) {
    console.error('[Email Store] Could not write store file:', err.message)
  }
}

function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(10).toString('hex')
}

// Filter matching for the file store. Supports equality and $in, $nin, $ne,
// $lte, $lt, $gte, $gt, $exists, which is all the email module uses.
function matchValue(actual, cond) {
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case '$in': return v.some(x => matchValue(actual, x))
        case '$nin': return !v.some(x => matchValue(actual, x))
        case '$ne': return !matchValue(actual, v)
        case '$lte': return actual != null && actual <= v
        case '$lt': return actual != null && actual < v
        case '$gte': return actual != null && actual >= v
        case '$gt': return actual != null && actual > v
        case '$exists': return v ? actual !== undefined && actual !== null : actual === undefined || actual === null
        default: throw new Error('Unsupported filter operator ' + op)
      }
    })
  }
  if (Array.isArray(actual) && !Array.isArray(cond)) return actual.includes(cond)
  return (actual ?? null) === (cond ?? null)
}
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, cond]) => matchValue(doc[k], cond))
}
function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set)
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = Number(doc[k] || 0) + v
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) doc[k] = [...(doc[k] || []), v]
  return doc
}
function sortDocs(list, sort) {
  const [[key, dir]] = Object.entries(sort || { createdAt: -1 })
  return list.sort((a, b) => (a[key] > b[key] ? dir : a[key] < b[key] ? -dir : 0))
}
const clone = d => (d ? JSON.parse(JSON.stringify(d)) : d)

function collection(name, prefix) {
  const mongoName = 'email_' + name
  const useMongo = () => getMongoStatus() && mongoose.connection.db
  const col = () => mongoose.connection.db.collection(mongoName)
  const rows = () => {
    const data = fileData()
    if (!Array.isArray(data[name])) data[name] = []
    return data[name]
  }

  return {
    async insert(doc) {
      const now = new Date().toISOString()
      const record = { _id: newId(prefix), createdAt: now, updatedAt: now, ...doc }
      if (useMongo()) {
        await col().insertOne(record)
        return record
      }
      rows().push(clone(record))
      fileSave()
      return record
    },
    async findOne(filter) {
      if (useMongo()) return col().findOne(filter)
      return clone(rows().find(d => matches(d, filter)) || null)
    },
    async find(filter = {}, { sort, limit = 0, skip = 0 } = {}) {
      if (useMongo()) {
        let cur = col().find(filter).sort(sort || { createdAt: -1 }).skip(skip)
        if (limit) cur = cur.limit(limit)
        return cur.toArray()
      }
      const list = sortDocs(rows().filter(d => matches(d, filter)), sort)
      return clone(limit ? list.slice(skip, skip + limit) : list.slice(skip))
    },
    async count(filter = {}) {
      if (useMongo()) return col().countDocuments(filter)
      return rows().filter(d => matches(d, filter)).length
    },
    // Atomic find-and-update. Returns the updated doc, or null if nothing matched.
    async updateOne(filter, update) {
      const u = { ...update, $set: { ...(update.$set || {}), updatedAt: new Date().toISOString() } }
      if (useMongo()) {
        const res = await col().findOneAndUpdate(filter, u, { returnDocument: 'after' })
        return res && res.value !== undefined ? res.value : res
      }
      const doc = rows().find(d => matches(d, filter))
      if (!doc) return null
      applyUpdate(doc, u)
      fileSave()
      return clone(doc)
    },
    async deleteOne(filter) {
      if (useMongo()) return (await col().deleteOne(filter)).deletedCount > 0
      const list = rows()
      const i = list.findIndex(d => matches(d, filter))
      if (i < 0) return false
      list.splice(i, 1)
      fileSave()
      return true
    },
    async ensureIndexes(specs) {
      if (!useMongo()) return
      for (const [keys, opts] of specs) {
        try { await col().createIndex(keys, opts || {}) } catch (e) { console.warn('[Email Store] index', mongoName, e.message) }
      }
    }
  }
}

const db = {
  domains: collection('domains', 'edom'),
  identities: collection('identities', 'eid'),
  messages: collection('messages', 'emsg'),
  events: collection('events', 'eevt'),
  templates: collection('templates', 'etpl'),
  suppressions: collection('suppressions', 'esup'),
  accounts: collection('accounts', 'eacc')
}

async function ensureIndexes() {
  await db.domains.ensureIndexes([[{ name: 1 }, { unique: true }], [{ userId: 1 }]])
  await db.identities.ensureIndexes([[{ address: 1 }, { unique: true }], [{ userId: 1 }]])
  await db.messages.ensureIndexes([
    [{ userId: 1, createdAt: -1 }],
    [{ providerMessageId: 1 }],
    [{ status: 1, nextAttemptAt: 1 }],
    [{ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }]
  ])
  await db.events.ensureIndexes([[{ provider: 1, providerEventId: 1 }, { unique: true }]])
  await db.templates.ensureIndexes([[{ userId: 1 }]])
  await db.suppressions.ensureIndexes([[{ userId: 1, address: 1 }, { unique: true }]])
  await db.accounts.ensureIndexes([[{ userId: 1 }, { unique: true }]])
}

module.exports = { db, ensureIndexes, newId, _matches: matches }
