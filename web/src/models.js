const crypto = require('crypto')
const { mongoose, getMongoStatus } = require('./db')

// --------------------------------------------------------------------------
// MONGOOSE SCHEMAS
// --------------------------------------------------------------------------

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0, min: 0 },
  senderIds: { type: [String], default: ['TXTORA'] },
  isVerified: { type: Boolean, default: false },
  verificationCode: { type: String, default: null },
  verificationCodeExpiry: { type: Date, default: null },
  resetToken: { type: String, default: null },
  resetTokenExpiry: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
})

const apiKeySchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  key: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: 'Default Live Key' },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date }
})

const transactionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  reference: { type: String, required: true, unique: true, index: true },
  amountGHS: { type: Number, required: true },
  credits: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
  paymentPurpose: { type: String, default: 'textora_web_recharge' },
  createdAt: { type: Date, default: Date.now }
})

const smsLogSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  recipients: { type: [String], required: true },
  message: { type: String, required: true },
  senderId: { type: String, default: 'TXTORA' },
  unitsDebited: { type: Number, required: true },
  remainingBalance: { type: Number, required: true },
  status: { type: String, default: 'success' },
  createdAt: { type: Date, default: Date.now }
})

const senderIdRequestSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  senderId: { type: String, required: true },
  purpose: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  feeAmountGHS: { type: Number, default: 1 },
  paymentMethod: { type: String, default: 'wallet' },
  paymentReference: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
})

let UserModel, ApiKeyModel, TransactionModel, SmsLogModel, SenderIdRequestModel
try {
  UserModel = mongoose.model('User', userSchema)
  ApiKeyModel = mongoose.model('ApiKey', apiKeySchema)
  TransactionModel = mongoose.model('Transaction', transactionSchema)
  SmsLogModel = mongoose.model('SmsLog', smsLogSchema)
  SenderIdRequestModel = mongoose.model('SenderIdRequest', senderIdRequestSchema)
} catch (e) {
  UserModel = mongoose.models.User
  ApiKeyModel = mongoose.models.ApiKey
  TransactionModel = mongoose.models.Transaction
  SmsLogModel = mongoose.models.SmsLog
  SenderIdRequestModel = mongoose.models.SenderIdRequest
}

// --------------------------------------------------------------------------
// LOCAL FILE-BACKED REPOSITORY (FALLBACK IF MONGO IS NOT REACHABLE)
// --------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')

const STORE_FILE = path.join(__dirname, '../../data/web-store.json')

function ensureStoreDir() {
  const dir = path.dirname(STORE_FILE)
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {}
  }
}

function loadStore() {
  try {
    ensureStoreDir()
    if (fs.existsSync(STORE_FILE)) {
      const content = fs.readFileSync(STORE_FILE, 'utf8')
      const parsed = JSON.parse(content)
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        apiKeys: Array.isArray(parsed.apiKeys) ? parsed.apiKeys : [],
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        smsLogs: Array.isArray(parsed.smsLogs) ? parsed.smsLogs : [],
        senderIdRequests: Array.isArray(parsed.senderIdRequests) ? parsed.senderIdRequests : []
      }
    }
  } catch (err) {
    console.error('[Web Store Load Error]', err.message)
  }
  return {
    users: [],
    apiKeys: [],
    transactions: [],
    smsLogs: [],
    senderIdRequests: []
  }
}

function saveStore(store) {
  try {
    ensureStoreDir()
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8')
  } catch (err) {
    console.error('[Web Store Save Error]', err.message)
  }
}

// --------------------------------------------------------------------------
// UNIFIED REPOSITORY INTERFACE
// --------------------------------------------------------------------------

const UserRepo = {
  async create({ name, email, phone, passwordHash, initialBalance = 0, isVerified = false, verificationCode = null, verificationCodeExpiry = null }) {
    let savedObj = null
    if (getMongoStatus()) {
      try {
        const u = new UserModel({
          name,
          email: email.toLowerCase().trim(),
          phone: phone ? phone.trim() : '',
          passwordHash,
          balance: initialBalance,
          isVerified,
          verificationCode,
          verificationCodeExpiry
        })
        const saved = await u.save()
        savedObj = saved.toObject()
      } catch (e) {
        if (e.code === 11000) {
          throw new Error('Email already registered')
        }
        console.warn('[UserRepo] Mongo save failed, using file store:', e.message)
      }
    }
    const store = loadStore()
    const existing = store.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase())
    if (existing && !savedObj) {
      throw new Error('Email already registered')
    }
    const id = savedObj ? String(savedObj._id) : ('usr_' + crypto.randomBytes(8).toString('hex'))
    const user = {
      _id: id,
      id,
      name,
      email: email.toLowerCase().trim(),
      phone: phone ? phone.trim() : '',
      passwordHash,
      balance: initialBalance,
      senderIds: ['TXTORA'],
      isVerified,
      verificationCode,
      verificationCodeExpiry,
      createdAt: new Date().toISOString()
    }
    const existingIdx = store.users.findIndex(u => u.email && u.email.toLowerCase() === email.toLowerCase())
    if (existingIdx >= 0) {
      store.users[existingIdx] = user
    } else {
      store.users.push(user)
    }
    saveStore(store)
    return savedObj || user
  },

  async findByEmail(email) {
    if (getMongoStatus()) {
      const u = await UserModel.findOne({ email: email.toLowerCase().trim() })
      if (u) return u.toObject()
    }
    const store = loadStore()
    return store.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim()) || null
  },

  async findById(id) {
    if (getMongoStatus()) {
      try {
        if (mongoose.Types.ObjectId.isValid(id)) {
          const u = await UserModel.findById(id)
          if (u) return u.toObject()
        }
        const u = await UserModel.findOne({ _id: id })
        if (u) return u.toObject()
      } catch (e) {}
    }
    const store = loadStore()
    return store.users.find(u => String(u._id) === String(id) || String(u.id) === String(id)) || null
  },

  async debitBalance(userId, amount) {
    const debitAmount = Number(amount)
    if (getMongoStatus()) {
      const updated = await UserModel.findOneAndUpdate(
        { _id: userId, balance: { $gte: debitAmount } },
        { $inc: { balance: -debitAmount } },
        { new: true }
      )
      if (!updated) {
        const user = await UserModel.findById(userId)
        return { ok: false, balance: user ? user.balance : 0, message: 'Insufficient balance' }
      }
      return { ok: true, balance: updated.balance }
    }

    const store = loadStore()
    const user = store.users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId))
    if (!user) return { ok: false, message: 'User not found' }
    if (user.balance < debitAmount) {
      return { ok: false, balance: user.balance, message: 'Insufficient balance' }
    }
    user.balance = Number((user.balance - debitAmount).toFixed(2))
    saveStore(store)
    return { ok: true, balance: user.balance }
  },

  async creditBalance(userId, amount) {
    const creditAmount = Number(amount)
    if (getMongoStatus()) {
      const updated = await UserModel.findByIdAndUpdate(
        userId,
        { $inc: { balance: creditAmount } },
        { new: true }
      )
      return { ok: true, balance: updated ? updated.balance : 0 }
    }
    const store = loadStore()
    const user = store.users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId))
    if (!user) return { ok: false, message: 'User not found' }
    user.balance = Number((user.balance + creditAmount).toFixed(2))
    saveStore(store)
    return { ok: true, balance: user.balance }
  },

  async addSenderId(userId, senderId) {
    const cleanSid = String(senderId).trim().toUpperCase()
    if (getMongoStatus()) {
      try {
        await UserModel.findByIdAndUpdate(userId, { $addToSet: { senderIds: cleanSid } })
      } catch (e) {}
    }
    const store = loadStore()
    const user = store.users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId))
    if (user) {
      if (!Array.isArray(user.senderIds)) user.senderIds = ['TXTORA']
      if (!user.senderIds.includes(cleanSid)) {
        user.senderIds.push(cleanSid)
        saveStore(store)
      }
    }
  },

  async setResetToken(email, token, expiry) {
    if (getMongoStatus()) {
      await UserModel.findOneAndUpdate(
        { email: email.toLowerCase() },
        { resetToken: token, resetTokenExpiry: expiry }
      )
    }
    const store = loadStore()
    const user = store.users.find(u => u.email === email.toLowerCase())
    if (user) {
      user.resetToken = token
      user.resetTokenExpiry = expiry
      saveStore(store)
    }
  },

  async findByResetToken(token) {
    if (getMongoStatus()) {
      const user = await UserModel.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } })
      if (user) return user.toObject()
      return null
    }
    const store = loadStore()
    const now = new Date()
    return store.users.find(u => u.resetToken === token && u.resetTokenExpiry && new Date(u.resetTokenExpiry) > now) || null
  },

  async updatePassword(userId, passwordHash) {
    if (getMongoStatus()) {
      await UserModel.findByIdAndUpdate(userId, {
        passwordHash,
        resetToken: null,
        resetTokenExpiry: null
      })
    }
    const store = loadStore()
    const user = store.users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId))
    if (user) {
      user.passwordHash = passwordHash
      user.resetToken = null
      user.resetTokenExpiry = null
      saveStore(store)
    }
  },

  async setVerificationCode(email, code, expiry) {
    const cleanEmail = email.toLowerCase().trim()
    if (getMongoStatus()) {
      await UserModel.findOneAndUpdate(
        { email: cleanEmail },
        { verificationCode: code, verificationCodeExpiry: expiry }
      )
    }
    const store = loadStore()
    const user = store.users.find(u => u.email && u.email.toLowerCase() === cleanEmail)
    if (user) {
      user.verificationCode = code
      user.verificationCodeExpiry = expiry
      saveStore(store)
    }
  },

  async updateUnverifiedUser(userId, { name, phone, passwordHash, code, expiry }) {
    if (getMongoStatus()) {
      await UserModel.findByIdAndUpdate(userId, {
        name,
        phone: phone ? phone.trim() : '',
        passwordHash,
        verificationCode: code,
        verificationCodeExpiry: expiry,
        balance: 0,
        isVerified: false
      })
    }
    const store = loadStore()
    const user = store.users.find(u => String(u._id) === String(userId) || String(u.id) === String(userId))
    if (user) {
      user.name = name
      if (phone) user.phone = phone.trim()
      user.passwordHash = passwordHash
      user.verificationCode = code
      user.verificationCodeExpiry = expiry
      user.balance = 0
      user.isVerified = false
      saveStore(store)
    }
  },

  async verifyUserEmail(email, code) {
    const cleanEmail = email.toLowerCase().trim()
    const cleanCode = String(code).trim()
    const now = new Date()

    if (getMongoStatus()) {
      const user = await UserModel.findOne({ email: cleanEmail })
      if (!user) return { ok: false, message: 'User not found' }
      if (user.isVerified) return { ok: true, user: user.toObject(), alreadyVerified: true }
      if (!user.verificationCode || user.verificationCode !== cleanCode) {
        return { ok: false, message: 'Invalid verification code' }
      }
      if (user.verificationCodeExpiry && new Date(user.verificationCodeExpiry) < now) {
        return { ok: false, message: 'Verification code has expired. Please request a new one.' }
      }

      user.isVerified = true
      user.verificationCode = null
      user.verificationCodeExpiry = null
      if (!user.balance || user.balance < 5) {
        user.balance = 5 // Credit 5 free starter SMS units only upon verified email
      }
      await user.save()
      return { ok: true, user: user.toObject() }
    }

    const store = loadStore()
    const user = store.users.find(u => u.email && u.email.toLowerCase() === cleanEmail)
    if (!user) return { ok: false, message: 'User not found' }
    if (user.isVerified) return { ok: true, user, alreadyVerified: true }
    if (!user.verificationCode || user.verificationCode !== cleanCode) {
      return { ok: false, message: 'Invalid verification code' }
    }
    if (user.verificationCodeExpiry && new Date(user.verificationCodeExpiry) < now) {
      return { ok: false, message: 'Verification code has expired. Please request a new one.' }
    }

    user.isVerified = true
    user.verificationCode = null
    user.verificationCodeExpiry = null
    if (!user.balance || user.balance < 5) {
      user.balance = 5
    }
    saveStore(store)
    return { ok: true, user }
  }
}

const ApiKeyRepo = {
  async generate(userId, name = 'Live API Key') {
    const key = 'ksnd_live_' + crypto.randomBytes(16).toString('hex')
    if (getMongoStatus()) {
      const k = new ApiKeyModel({ userId, key, name, status: 'active' })
      const saved = await k.save()
      return saved.toObject()
    }
    const store = loadStore()
    const record = {
      _id: 'key_' + crypto.randomBytes(8).toString('hex'),
      userId: String(userId),
      key,
      name,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    }
    store.apiKeys.push(record)
    saveStore(store)
    return record
  },

  async listByUser(userId) {
    if (getMongoStatus()) {
      const keys = await ApiKeyModel.find({ userId: String(userId), status: 'active' }).sort({ createdAt: -1 })
      if (keys && keys.length) return keys.map(k => k.toObject())
    }
    const store = loadStore()
    return store.apiKeys.filter(k => String(k.userId) === String(userId) && k.status === 'active')
  },

  async findByKey(key) {
    if (getMongoStatus()) {
      const k = await ApiKeyModel.findOne({ key, status: 'active' })
      if (k) return k.toObject()
    }
    const store = loadStore()
    return store.apiKeys.find(k => k.key === key && k.status === 'active') || null
  },

  async revoke(userId, keyId) {
    if (getMongoStatus()) {
      try {
        await ApiKeyModel.findOneAndUpdate({ _id: keyId, userId: String(userId) }, { status: 'revoked' })
      } catch (e) {}
    }
    const store = loadStore()
    const k = store.apiKeys.find(item => (String(item._id) === String(keyId) || String(item.id) === String(keyId)) && String(item.userId) === String(userId))
    if (k) {
      k.status = 'revoked'
      saveStore(store)
      return true
    }
    return false
  }
}

const TransactionRepo = {
  async create({ userId, reference, amountGHS, credits, paymentPurpose = 'textora_web_recharge' }) {
    if (getMongoStatus()) {
      const tx = new TransactionModel({ userId: String(userId), reference, amountGHS, credits, paymentPurpose, status: 'pending' })
      const saved = await tx.save()
      return saved.toObject()
    }
    const store = loadStore()
    const record = {
      _id: 'tx_' + crypto.randomBytes(8).toString('hex'),
      userId: String(userId),
      reference,
      amountGHS: Number(amountGHS),
      credits: Number(credits),
      status: 'pending',
      paymentPurpose,
      createdAt: new Date().toISOString()
    }
    store.transactions.push(record)
    saveStore(store)
    return record
  },

  async findByReference(reference) {
    if (getMongoStatus()) {
      const tx = await TransactionModel.findOne({ reference })
      if (tx) return tx.toObject()
    }
    const store = loadStore()
    return store.transactions.find(t => t.reference === reference) || null
  },

  async markSuccess(reference) {
    if (getMongoStatus()) {
      const updated = await TransactionModel.findOneAndUpdate({ reference, status: 'pending' }, { status: 'success' }, { new: true })
      if (updated) return updated.toObject()
    }
    const store = loadStore()
    const tx = store.transactions.find(t => t.reference === reference && t.status === 'pending')
    if (tx) {
      tx.status = 'success'
      saveStore(store)
      return tx
    }
    return null
  }
}

const SmsLogRepo = {
  async create({ userId, recipients, message, senderId = 'TXTORA', unitsDebited, remainingBalance, status = 'success' }) {
    if (getMongoStatus()) {
      const log = new SmsLogModel({ userId: String(userId), recipients, message, senderId, unitsDebited, remainingBalance, status })
      const saved = await log.save()
      return saved.toObject()
    }
    const store = loadStore()
    const record = {
      _id: 'log_' + crypto.randomBytes(8).toString('hex'),
      userId: String(userId),
      recipients: Array.isArray(recipients) ? recipients : [recipients],
      message,
      senderId,
      unitsDebited: Number(unitsDebited),
      remainingBalance: Number(remainingBalance),
      status,
      createdAt: new Date().toISOString()
    }
    store.smsLogs.unshift(record)
    saveStore(store)
    return record
  },

  async listByUser(userId, limit = 50) {
    if (getMongoStatus()) {
      const logs = await SmsLogModel.find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(limit)
      if (logs && logs.length) return logs.map(l => l.toObject())
    }
    const store = loadStore()
    return store.smsLogs.filter(l => String(l.userId) === String(userId)).slice(0, limit)
  }
}

const SenderIdRequestRepo = {
  async create({ userId, senderId, purpose, feeAmountGHS = 1, paymentMethod = 'wallet', paymentReference = '' }) {
    const cleanSid = senderId.toUpperCase().trim()
    let savedObj = null
    if (getMongoStatus()) {
      try {
        const req = new SenderIdRequestModel({
          userId: String(userId),
          senderId: cleanSid,
          purpose,
          status: 'pending',
          feeAmountGHS: Number(feeAmountGHS),
          paymentMethod,
          paymentReference
        })
        const saved = await req.save()
        savedObj = saved.toObject()
      } catch (e) {
        console.warn('[SenderIdRequestRepo] Mongo save failed, using file store:', e.message)
      }
    }
    const store = loadStore()
    const id = savedObj ? String(savedObj._id) : ('sid_' + crypto.randomBytes(8).toString('hex'))
    const record = {
      _id: id,
      id: id,
      userId: String(userId),
      senderId: cleanSid,
      purpose: purpose || 'Business Messaging',
      status: 'pending',
      feeAmountGHS: Number(feeAmountGHS),
      paymentMethod,
      paymentReference,
      createdAt: savedObj?.createdAt || new Date().toISOString()
    }
    const existingIdx = store.senderIdRequests.findIndex(s => String(s._id) === id)
    if (existingIdx >= 0) {
      store.senderIdRequests[existingIdx] = record
    } else {
      store.senderIdRequests.unshift(record)
    }
    saveStore(store)
    return savedObj || record
  },

  async findById(id) {
    if (getMongoStatus()) {
      try {
        if (mongoose.Types.ObjectId.isValid(id)) {
          const doc = await SenderIdRequestModel.findById(id)
          if (doc) return doc.toObject()
        }
        const doc = await SenderIdRequestModel.findOne({ _id: id })
        if (doc) return doc.toObject()
      } catch (e) {}
    }
    const store = loadStore()
    return store.senderIdRequests.find(s => String(s._id) === String(id) || String(s.id) === String(id)) || null
  },

  async updateStatus(id, status) {
    if (getMongoStatus()) {
      try {
        let doc = null
        if (mongoose.Types.ObjectId.isValid(id)) {
          doc = await SenderIdRequestModel.findByIdAndUpdate(id, { status }, { new: true })
        }
        if (!doc) {
          doc = await SenderIdRequestModel.findOneAndUpdate({ _id: id }, { status }, { new: true })
        }
        if (doc) return doc.toObject()
      } catch (e) {}
    }
    const store = loadStore()
    const item = store.senderIdRequests.find(s => String(s._id) === String(id) || String(s.id) === String(id))
    if (item) {
      item.status = status
      saveStore(store)
      return { ...item }
    }
    return null
  },

  async listByUser(userId) {
    if (getMongoStatus()) {
      const list = await SenderIdRequestModel.find({ userId: String(userId) }).sort({ createdAt: -1 })
      if (list && list.length) return list.map(s => s.toObject())
    }
    const store = loadStore()
    return store.senderIdRequests.filter(s => String(s.userId) === String(userId))
  }
}

module.exports = {
  UserRepo,
  ApiKeyRepo,
  TransactionRepo,
  SmsLogRepo,
  SenderIdRequestRepo
}
