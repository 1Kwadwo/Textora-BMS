require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
require('dotenv').config() // also load web/.env if any

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { connectDB } = require('./src/db')
const { UserRepo, ApiKeyRepo, TransactionRepo, SmsLogRepo, SenderIdRequestRepo } = require('./src/models')
const { hashPassword, comparePassword, generateToken, verifyToken, extractBearerToken } = require('./src/auth')
const { isGhanaNumber, normalizeNumber, calculateSMSUnits, sendSMS } = require('./src/services/sms')
const { initializePayment, verifyPayment } = require('./src/services/paystack')
const { sendTelegramSenderIdAlert } = require('./src/services/telegramAlert')
const { sendPasswordResetEmail } = require('./src/services/email')

const PORT = Number(process.env.PORT || process.env.WEB_PORT || 4000)
const PUBLIC_DIR = path.join(__dirname, 'public')
const ROOT_DIR = path.join(__dirname, '..')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
}

const API_PLANS = [
  { id: 1, priceGHS: 20, credits: 400, popular: false, tag: 'Starter' },
  { id: 2, priceGHS: 50, credits: 1000, popular: false, tag: 'Basic' },
  { id: 3, priceGHS: 100, credits: 2000, popular: true, tag: 'Growth' },
  { id: 4, priceGHS: 200, credits: 4000, popular: false, tag: 'Pro' },
  { id: 5, priceGHS: 500, credits: 10000, popular: false, tag: 'Business' },
  { id: 6, priceGHS: 1000, credits: 20000, popular: false, tag: 'Scale' },
  { id: 7, priceGHS: 2000, credits: 40000, popular: false, tag: 'Enterprise' },
  { id: 8, priceGHS: 5000, credits: 100000, popular: false, tag: 'High Volume' }
]

// CORS allow-list. The dashboard is same-origin (needs no CORS); the public API is server-to-server.
// Set CORS_ALLOWED_ORIGINS="https://app.example.com,https://example.com" to permit browser cross-origin calls.
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

// Minimal in-memory, per-process rate limiter (per key + sliding fixed window).
const rateBuckets = new Map()
function rateLimit(key, maxHits, windowMs) {
  const now = Date.now()
  const entry = rateBuckets.get(key)
  if (!entry || now > entry.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs })
    return { ok: true }
  }
  entry.count++
  if (entry.count > maxHits) return { ok: false, retryAfter: Math.ceil((entry.reset - now) / 1000) }
  return { ok: true }
}
const _rlSweep = setInterval(() => {
  const now = Date.now()
  for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k)
}, 60000)
if (_rlSweep.unref) _rlSweep.unref()

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
}

// Connect to MongoDB
connectDB().catch(err => console.error('DB Startup error:', err.message))

const server = http.createServer(async (req, res) => {

  
  const reqOrigin = req.headers['origin']
  if (reqOrigin && CORS_ALLOWED_ORIGINS.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')

  // Baseline security headers
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (String(req.headers['x-forwarded-proto'] || '').includes('https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const urlPath = urlObj.pathname

  function json(status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  function parseBody() {
    return new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8')
        if (!bodyStr) return resolve({})
        try {
          resolve(JSON.parse(bodyStr))
        } catch (e) {
          reject(new Error('Invalid JSON body'))
        }
      })
    })
  }

  async function authenticateUser() {
    const token = extractBearerToken(req)
    if (!token) return null
    const payload = verifyToken(token)
    if (!payload || !payload.userId) return null
    const user = await UserRepo.findById(payload.userId)
    return user
  }

  async function authenticateApiKey() {
    let key = req.headers['x-api-key']
    if (!key) {
      const auth = req.headers['authorization']
      if (auth && auth.startsWith('Bearer ')) {
        const t = auth.substring(7).trim()
        // Accept both the new (ksnd_) and legacy (txt_) key prefixes
        if (t.startsWith('ksnd_') || t.startsWith('txt_')) key = t
      }
    }
    if (!key) return null
    const apiKeyDoc = await ApiKeyRepo.findByKey(key)
    if (!apiKeyDoc) return null
    const user = await UserRepo.findById(apiKeyDoc.userId)
    return { apiKeyDoc, user }
  }

  // --------------------------------------------------------------------------
  // AUTHENTICATION ROUTES
  // --------------------------------------------------------------------------

  if (urlPath === '/api/auth/register' && req.method === 'POST') {
    try {
      const rl = rateLimit('register:' + clientIp(req), 10, 60 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many sign-up attempts. Please try again later.' })
      const body = await parseBody()
      const { name, email, password, phone } = body
      if (!name || !email || !password) {
        return json(400, { ok: false, message: 'Name, email, and password are required.' })
      }
      if (password.length < 6) {
        return json(400, { ok: false, message: 'Password must be at least 6 characters long.' })
      }

      const existing = await UserRepo.findByEmail(email)
      if (existing) {
        return json(400, { ok: false, message: 'An account with this email already exists.' })
      }

      const passwordHash = await hashPassword(password)
      const user = await UserRepo.create({ name, email, phone, passwordHash, initialBalance: 5 }) // Give 5 free starter test credits!
      
      // Auto-generate initial API key
      const initialKey = await ApiKeyRepo.generate(user._id || user.id, 'Initial Default Key')
      const token = generateToken(user)

      return json(200, {
        ok: true,
        message: 'Account created successfully!',
        token,
        user: {
          id: user._id || user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          balance: user.balance,
          senderIds: user.senderIds
        },
        initialApiKey: initialKey.key
      })
    } catch (err) {
      console.error('[register error]', err)
      return json(500, { ok: false, message: 'Something went wrong creating your account.' })
    }
  }

  if (urlPath === '/api/auth/login' && req.method === 'POST') {
    try {
      const rl = rateLimit('login:' + clientIp(req), 10, 15 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many login attempts. Please try again in a few minutes.' })
      const body = await parseBody()
      const { email, password } = body
      if (!email || !password) {
        return json(400, { ok: false, message: 'Email and password are required.' })
      }

      const user = await UserRepo.findByEmail(email)
      if (!user) {
        return json(401, { ok: false, message: 'Invalid email or password.' })
      }

      const isMatch = await comparePassword(password, user.passwordHash)
      if (!isMatch) {
        return json(401, { ok: false, message: 'Invalid email or password.' })
      }

      const token = generateToken(user)
      return json(200, {
        ok: true,
        message: 'Login successful!',
        token,
        user: {
          id: user._id || user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          balance: user.balance,
          senderIds: user.senderIds
        }
      })
    } catch (err) {
      console.error('[login error]', err)
      return json(500, { ok: false, message: 'Something went wrong signing you in.' })
    }
  }

  // ── Forgot Password ──────────────────────────────────────────────────────
  if (urlPath === '/api/auth/forgot-password' && req.method === 'POST') {
    try {
      const rl = rateLimit('forgot:' + clientIp(req), 10, 15 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many reset requests. Please wait a few minutes.' })
      const body = await parseBody()
      const { email } = body
      if (!email) return json(400, { ok: false, message: 'Email is required.' })
      const user = await UserRepo.findByEmail(email)
      // Always respond ok to prevent email enumeration
      if (user) {
        const token = crypto.randomBytes(32).toString('hex')
        const expiry = new Date(Date.now() + 60 * 60 * 1000) // 1 hour
        await UserRepo.setResetToken(email, token, expiry)
        await sendPasswordResetEmail({ to: user.email, name: user.name, resetToken: token })
      }
      return json(200, { ok: true, message: 'If that email is registered, a reset link has been sent.' })
    } catch (err) {
      console.error('[Forgot Password Error]', err.message)
      return json(500, { ok: false, message: 'Something went wrong. Please try again.' })
    }
  }

  // ── Reset Password ───────────────────────────────────────────────────────
  if (urlPath === '/api/auth/reset-password' && req.method === 'POST') {
    try {
      const rl = rateLimit('reset:' + clientIp(req), 10, 15 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many reset attempts. Please wait a few minutes.' })
      const body = await parseBody()
      const { token, password } = body
      if (!token || !password) return json(400, { ok: false, message: 'Token and new password are required.' })
      if (password.length < 6) return json(400, { ok: false, message: 'Password must be at least 6 characters.' })
      const user = await UserRepo.findByResetToken(token)
      if (!user) return json(400, { ok: false, message: 'This reset link is invalid or has expired.' })
      const passwordHash = await hashPassword(password)
      await UserRepo.updatePassword(user._id || user.id, passwordHash)
      return json(200, { ok: true, message: 'Password updated successfully. You can now sign in.' })
    } catch (err) {
      console.error('[Reset Password Error]', err.message)
      return json(500, { ok: false, message: 'Something went wrong. Please try again.' })
    }
  }

  if (urlPath === '/api/auth/me' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) {
      return json(401, { ok: false, message: 'Unauthorized. Please log in.' })
    }
    return json(200, {
      ok: true,
      user: {
        id: user._id || user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        balance: user.balance,
        senderIds: user.senderIds
      }
    })
  }

  // --------------------------------------------------------------------------
  // USER DASHBOARD ROUTES
  // --------------------------------------------------------------------------

  if (urlPath === '/api/dashboard/overview' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const userId = user._id || user.id
    const apiKeys = await ApiKeyRepo.listByUser(userId)
    const logs = await SmsLogRepo.listByUser(userId, 10)
    const senderIdRequests = await SenderIdRequestRepo.listByUser(userId)

    const feeGHS = Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 8)

    return json(200, {
      ok: true,
      customSenderIdFeeGHS: feeGHS,
      user: {
        id: userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        balance: user.balance,
        senderIds: user.senderIds
      },
      apiKeys,
      logs,
      senderIdRequests
    })
  }

  if (urlPath === '/api/dashboard/api-keys' && req.method === 'POST') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const body = await parseBody()
    const name = body.name || 'Live Key ' + new Date().toLocaleDateString()
    const keyRecord = await ApiKeyRepo.generate(user._id || user.id, name)

    return json(200, { ok: true, apiKey: keyRecord })
  }

  if (urlPath.startsWith('/api/dashboard/api-keys/') && req.method === 'DELETE') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const keyId = urlPath.split('/').pop()
    const success = await ApiKeyRepo.revoke(user._id || user.id, keyId)
    return json(200, { ok: success, message: success ? 'API key revoked' : 'Key not found' })
  }

  if (urlPath === '/api/dashboard/send-sms' && req.method === 'POST') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const rlSms = rateLimit('dash-sms:' + (user._id || user.id), 60, 60 * 1000)
    if (!rlSms.ok) return json(429, { ok: false, message: 'Sending too fast. Please wait a moment and try again.' })

    const body = await parseBody()
    const { to, message, senderId } = body
    if (!to || !message) {
      return json(400, { ok: false, message: 'Recipients ("to") and "message" are required.' })
    }

    let recipients = []
    if (Array.isArray(to)) recipients = to.map(normalizeNumber).filter(Boolean)
    else if (typeof to === 'string') recipients = to.split(/[\n,;]+/).map(normalizeNumber).filter(Boolean)

    if (recipients.length === 0) {
      return json(400, { ok: false, message: 'No valid recipient phone numbers provided.' })
    }

    // Authorize the sender ID: callers may only use IDs approved for their account (plus the generic default).
    const genericSender = (process.env.GENERIC_SENDER_ID || 'TXTORA').toUpperCase()
    const allowedSenders = new Set([...(user.senderIds || []).map(s => String(s).toUpperCase()), genericSender])
    const sId = senderId ? String(senderId).trim() : genericSender
    if (!allowedSenders.has(sId.toUpperCase())) {
      return json(403, { ok: false, message: `Sender ID "${sId}" is not approved for your account. Register it under Sender IDs first.` })
    }

    const unitsPerMessage = calculateSMSUnits(message)
    let totalCreditsNeeded = 0
    for (const r of recipients) {
      totalCreditsNeeded += isGhanaNumber(r) ? unitsPerMessage * 1.0 : unitsPerMessage * 1.6
    }
    totalCreditsNeeded = Number(totalCreditsNeeded.toFixed(2))

    const userId = user._id || user.id
    const debitRes = await UserRepo.debitBalance(userId, totalCreditsNeeded)
    if (!debitRes.ok) {
      return json(400, {
        ok: false,
        message: `Insufficient balance. Required: ${totalCreditsNeeded} credits, Available: ${debitRes.balance} credits. Please recharge your wallet.`,
        requiredCredits: totalCreditsNeeded,
        currentBalance: debitRes.balance
      })
    }

    let arkeselRes
    try {
      arkeselRes = await sendSMS({ to: recipients, message, senderId: sId })
    } catch (sendErr) {
      // Refund on failure
      await UserRepo.creditBalance(userId, totalCreditsNeeded)
      return json(500, { ok: false, message: 'Carrier sending failed: ' + sendErr.message })
    }

    const logEntry = await SmsLogRepo.create({
      userId,
      recipients,
      message,
      senderId: sId,
      unitsDebited: totalCreditsNeeded,
      remainingBalance: debitRes.balance,
      status: 'success'
    })

    return json(200, {
      ok: true,
      message: `SMS dispatched to ${recipients.length} recipients successfully.`,
      units_debited: totalCreditsNeeded,
      remaining_balance: debitRes.balance,
      data: arkeselRes,
      log: logEntry
    })
  }

  if (urlPath === '/api/dashboard/logs' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const logs = await SmsLogRepo.listByUser(user._id || user.id, 50)
    return json(200, { ok: true, logs })
  }

  if (urlPath === '/api/dashboard/recharge' && req.method === 'POST') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const body = await parseBody()
    const planId = parseInt(body.planId || body.plan_id, 10)
    const plan = API_PLANS.find(p => p.id === planId)
    if (!plan) {
      return json(400, { ok: false, message: 'Invalid recharge planId selected.' })
    }

    const reference = 'web_topup_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
    const userId = user._id || user.id
    
    await TransactionRepo.create({
      userId,
      reference,
      amountGHS: plan.priceGHS,
      credits: plan.credits,
      paymentPurpose: `textora_web_plan_${plan.id}`
    })

    const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http')
    const callbackUrl = `${proto}://${req.headers.host || 'localhost:4000'}/#dashboard-billing?ref=${reference}`
    const payment = await initializePayment({
      email: user.email,
      amountGHS: plan.priceGHS,
      reference,
      callbackUrl
    })

    return json(200, {
      ok: true,
      plan_id: plan.id,
      amount_ghs: plan.priceGHS,
      credits: plan.credits,
      checkout_url: payment?.data?.authorization_url,
      reference
    })
  }

  if (urlPath === '/api/dashboard/verify-payment' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const reference = urlObj.searchParams.get('reference')
    if (!reference) return json(400, { ok: false, message: 'Missing transaction reference' })

    const tx = await TransactionRepo.findByReference(reference)
    if (!tx) return json(404, { ok: false, message: 'Transaction not found' })

    if (tx.status === 'success') {
      return json(200, { ok: true, message: 'Payment already verified', creditsAdded: tx.credits, currentBalance: user.balance })
    }

    const verifyRes = await verifyPayment(reference)
    if (verifyRes.status && verifyRes.data?.status === 'success') {
      // Atomically flip pending -> success; only the request that transitions it credits the wallet.
      const transitioned = await TransactionRepo.markSuccess(reference)
      if (!transitioned) {
        return json(200, { ok: true, message: 'Payment already verified', creditsAdded: tx.credits, currentBalance: user.balance })
      }
      const userId = user._id || user.id
      const creditRes = await UserRepo.creditBalance(userId, tx.credits)
      return json(200, {
        ok: true,
        message: `Payment confirmed! Added ${tx.credits} SMS credits to your wallet.`,
        creditsAdded: tx.credits,
        newBalance: creditRes.balance
      })
    } else {
      return json(400, { ok: false, message: 'Payment verification pending or failed.' })
    }
  }

  if (urlPath === '/api/dashboard/sender-id' && req.method === 'POST') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const body = await parseBody()
    const { senderId, purpose, paymentMethod = 'wallet' } = body
    if (!senderId || senderId.trim().length < 3 || senderId.trim().length > 11) {
      return json(400, { ok: false, message: 'Sender ID must be between 3 and 11 alphanumeric characters.' })
    }

    const userId = user._id || user.id
    const cleanSenderId = senderId.trim().toUpperCase()
    const feeGHS = Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 8)

    // Check if already active or pending
    const existingReqs = await SenderIdRequestRepo.listByUser(userId)
    const alreadyPending = existingReqs.find(r => r.senderId === cleanSenderId && r.status === 'pending')
    if (alreadyPending) {
      return json(400, { ok: false, message: `Sender ID "${cleanSenderId}" is already submitted and pending review.` })
    }
    if (user.senderIds && user.senderIds.includes(cleanSenderId)) {
      return json(400, { ok: false, message: `Sender ID "${cleanSenderId}" is already approved and active in your account.` })
    }

    if (paymentMethod === 'paystack') {
      const reference = 'sid_fee_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
      await TransactionRepo.create({
        userId,
        reference,
        amountGHS: feeGHS,
        credits: 0,
        paymentPurpose: `sender_id_fee:${cleanSenderId}:${encodeURIComponent(purpose || 'Business Messaging')}`
      })

      const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http')
      const callbackUrl = `${proto}://${req.headers.host || 'localhost:4000'}/#dashboard-sender-ids?ref=${reference}&sid=${cleanSenderId}`
      const payment = await initializePayment({
        email: user.email,
        amountGHS: feeGHS,
        reference,
        callbackUrl
      })

      return json(200, {
        ok: true,
        paymentRequired: true,
        paymentMethod: 'paystack',
        feeGHS,
        checkout_url: payment.data?.authorization_url || payment.authorization_url,
        reference
      })
    }

    // Default: Pay with account wallet balance
    const debitRes = await UserRepo.debitBalance(userId, feeGHS)
    if (!debitRes.ok) {
      return json(400, {
        ok: false,
        insufficientBalance: true,
        feeGHS,
        currentBalance: user.balance,
        message: `Insufficient wallet balance. Custom Sender ID registration fee is ₵${feeGHS.toFixed(2)}. Your current balance is ₵${Number(user.balance || 0).toFixed(2)}. Please recharge your wallet or choose Pay via Mobile Money/Card.`
      })
    }

    const reqRecord = await SenderIdRequestRepo.create({
      userId,
      senderId: cleanSenderId,
      purpose: purpose || 'Web business notification',
      feeAmountGHS: feeGHS,
      paymentMethod: 'wallet'
    })

    // Dispatch real-time Telegram notification to admin chat with 1-click inline buttons
    try {
      await sendTelegramSenderIdAlert({
        user,
        senderId: cleanSenderId,
        purpose: purpose || 'Web business notification',
        requestId: reqRecord._id || reqRecord.id,
        feeAmountGHS: feeGHS,
        paymentMethod: 'Wallet Balance'
      })
    } catch (alertErr) {
      console.error('[Telegram Alert Error]', alertErr.message)
    }

    return json(200, {
      ok: true,
      feePaid: feeGHS,
      remainingBalance: debitRes.balance,
      message: `Sender ID "${cleanSenderId}" submitted for review. Registration fee of ₵${feeGHS.toFixed(2)} deducted from your wallet balance. It will be approved shortly.`,
      senderIdRequest: reqRecord
    })
  }

  if (urlPath === '/api/dashboard/sender-id/verify-payment' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const reference = urlObj.searchParams.get('reference')
    if (!reference) return json(400, { ok: false, message: 'Missing transaction reference' })

    const tx = await TransactionRepo.findByReference(reference)
    if (!tx) return json(404, { ok: false, message: 'Transaction not found' })

    const userId = user._id || user.id
    const feeGHS = Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 8)

    let targetSid = 'CUSTOM'
    let targetPurpose = 'Business Messaging'
    if (tx.paymentPurpose && tx.paymentPurpose.startsWith('sender_id_fee:')) {
      const parts = tx.paymentPurpose.split(':')
      if (parts[1]) targetSid = parts[1].toUpperCase()
      if (parts[2]) {
        try { targetPurpose = decodeURIComponent(parts[2]) } catch(e) {}
      }
    }

    if (tx.status === 'success') {
      const existingReqs = await SenderIdRequestRepo.listByUser(userId)
      const existing = existingReqs.find(r => r.senderId === targetSid)
      return json(200, {
        ok: true,
        message: `Sender ID "${targetSid}" payment already confirmed and submitted for review.`,
        senderId: targetSid,
        senderIdRequest: existing
      })
    }

    const verifyRes = await verifyPayment(reference)
    if (verifyRes.status && verifyRes.data?.status === 'success') {
      // Only the request that transitions pending -> success creates the sender-ID request (prevents duplicates).
      const transitioned = await TransactionRepo.markSuccess(reference)
      if (!transitioned) {
        const existingReqs = await SenderIdRequestRepo.listByUser(userId)
        const existing = existingReqs.find(r => r.senderId === targetSid)
        return json(200, {
          ok: true,
          message: `Sender ID "${targetSid}" payment already confirmed and submitted for review.`,
          senderId: targetSid,
          senderIdRequest: existing
        })
      }

      const reqRecord = await SenderIdRequestRepo.create({
        userId,
        senderId: targetSid,
        purpose: targetPurpose,
        feeAmountGHS: feeGHS,
        paymentMethod: 'paystack',
        paymentReference: reference
      })

      try {
        await sendTelegramSenderIdAlert({
          user,
          senderId: targetSid,
          purpose: targetPurpose,
          requestId: reqRecord._id || reqRecord.id,
          feeAmountGHS: feeGHS,
          paymentMethod: 'Paystack MoMo / Card'
        })
      } catch (alertErr) {
        console.error('[Telegram Alert Error]', alertErr.message)
      }

      return json(200, {
        ok: true,
        message: `Payment confirmed! Sender ID "${targetSid}" submitted for review. It will be approved shortly.`,
        senderId: targetSid,
        senderIdRequest: reqRecord
      })
    } else {
      return json(400, { ok: false, message: 'Payment verification pending or failed.' })
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC DEVELOPER REST API GATEWAY (/api/v1/*)
  // (Works with keys generated from the Web Dashboard!)
  // --------------------------------------------------------------------------

  if (urlPath.startsWith('/api/v1/')) {
    const auth = await authenticateApiKey()
    if (!auth) {
      return json(401, { ok: false, message: 'Missing or invalid API key. Use Authorization: Bearer ksnd_live_... or x-api-key header.' })
    }

    const { user } = auth
    const userId = user._id || user.id

    if (urlPath === '/api/v1/balance' && req.method === 'GET') {
      return json(200, { ok: true, balance: user.balance, user_email: user.email })
    }

    if (urlPath === '/api/v1/logs' && req.method === 'GET') {
      const logs = await SmsLogRepo.listByUser(userId, 50)
      return json(200, { ok: true, logs })
    }

    if (urlPath === '/api/v1/sender-ids' && req.method === 'GET') {
      return json(200, { ok: true, senderIds: user.senderIds || ['TXTORA'] })
    }

    if (urlPath === '/api/v1/send-sms' && req.method === 'POST') {
      try {
        const rlSms = rateLimit('api-sms:' + userId, 120, 60 * 1000)
        if (!rlSms.ok) return json(429, { ok: false, message: 'Rate limit exceeded. Please slow down your requests.' })
        const body = await parseBody()
        const { to, message, senderId } = body
        if (!to || !message) {
          return json(400, { ok: false, message: 'Missing "to" or "message" parameter' })
        }

        let recipients = []
        if (Array.isArray(to)) recipients = to.map(normalizeNumber).filter(Boolean)
        else if (typeof to === 'string') recipients = to.split(/[\n,;]+/).map(normalizeNumber).filter(Boolean)

        if (recipients.length === 0) {
          return json(400, { ok: false, message: 'No valid recipients in "to"' })
        }

        const genericSender = (process.env.GENERIC_SENDER_ID || 'TXTORA').toUpperCase()
        const allowedSenders = new Set([...(user.senderIds || []).map(s => String(s).toUpperCase()), genericSender])
        const sId = senderId ? String(senderId).trim() : genericSender
        if (!allowedSenders.has(sId.toUpperCase())) {
          return json(403, { ok: false, message: `Sender ID "${sId}" is not approved for your account.` })
        }

        const msgUnits = calculateSMSUnits(message)
        let totalCreditsNeeded = 0
        for (const r of recipients) {
          totalCreditsNeeded += isGhanaNumber(r) ? msgUnits * 1.0 : msgUnits * 1.6
        }
        totalCreditsNeeded = Number(totalCreditsNeeded.toFixed(2))

        const debitRes = await UserRepo.debitBalance(userId, totalCreditsNeeded)
        if (!debitRes.ok) {
          return json(400, { ok: false, message: debitRes.message || 'Insufficient balance', balance: debitRes.balance })
        }

        let sendRes
        try {
          sendRes = await sendSMS({ to: recipients, message, senderId: sId })
        } catch (err) {
          await UserRepo.creditBalance(userId, totalCreditsNeeded)
          return json(500, { ok: false, message: 'Carrier failure: ' + err.message })
        }

        await SmsLogRepo.create({
          userId,
          recipients,
          message,
          senderId: sId,
          unitsDebited: totalCreditsNeeded,
          remainingBalance: debitRes.balance,
          status: 'success'
        })

        return json(200, {
          ok: true,
          total_units_debited: totalCreditsNeeded,
          remaining_balance: debitRes.balance,
          data: sendRes
        })
      } catch (err) {
        console.error('[api/v1/send-sms error]', err)
        return json(500, { ok: false, message: 'Failed to process send request.' })
      }
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC PLANS & STATIC ASSETS
  // --------------------------------------------------------------------------

  if (urlPath === '/health') {
    return json(200, { ok: true, service: 'kebsend-web' })
  }

  if (urlPath === '/api/plans' && req.method === 'GET') {
    return json(200, {
      ok: true,
      pricing: { localGHS: 0.05, internationalGHS: 0.08, customSenderIdFeeGHS: Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 8), genericSenderId: 'TXTORA' },
      plans: API_PLANS
    })
  }

  if (urlPath === '/docs/architecture') {
    const pdfPath = path.join(ROOT_DIR, 'KebSEND_Architecture_Documentation.pdf')
    if (fs.existsSync(pdfPath)) {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="KebSEND_Architecture_Documentation.pdf"' })
      fs.createReadStream(pdfPath).pipe(res)
      return
    }
  }

  if (urlPath === '/docs/terms') {
    const pdfPath = path.join(ROOT_DIR, 'KebSEND_Legal_Terms.pdf')
    if (fs.existsSync(pdfPath)) {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="KebSEND_Legal_Terms.pdf"' })
      fs.createReadStream(pdfPath).pipe(res)
      return
    }
  }

  // Static files
  let safePath = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[\/\\])+/, '')
  if (safePath === '/' || safePath === '' || safePath === '/reset-password') safePath = '/index.html'

  const filePath = path.join(PUBLIC_DIR, safePath)
  // Containment: never serve anything resolving outside the public directory.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return json(403, { ok: false, message: 'Forbidden' })
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType })
    fs.createReadStream(filePath).pipe(res)
    return
  }

  return json(404, { ok: false, message: 'Not Found' })
})

server.listen(PORT, () => {
  console.log(`🚀 KebSEND Web Platform & Auth API running at http://localhost:${PORT}`)
})

module.exports = server
