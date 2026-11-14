require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
require('dotenv').config() // also load web/.env if any

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const { connectDB } = require('./src/db')
const { UserRepo, ApiKeyRepo, TransactionRepo, SmsLogRepo, SenderIdRequestRepo } = require('./src/models')
const { hashPassword, comparePassword, generateToken, verifyToken, extractBearerToken } = require('./src/auth')
const { isGhanaNumber, normalizeNumber, toCanonicalGhanaPhone, calculateSMSUnits, sendSMS } = require('./src/services/sms')
const { initializePayment, verifyPayment } = require('./src/services/paystack')
const { fulfillSenderIdFee, notifyAdmin, reconcileUserSenderIdFees, isValidWebSenderId, allowedSenderIdsFor, requestWebSenderId } = require('./src/services/senderIdRequests')
const { sendPasswordResetEmail, sendVerificationEmail } = require('./src/services/email')
const { handleEmailRoutes } = require('./src/email/routes')
const emailWallet = require('./src/email/wallet')
const emailEngine = require('./src/email/engine')
const { keyHasScope } = require('./src/models')
const payg = require('./src/payg')

// A phone number can sit on one account only. Checks the number against every
// other account (in any stored format) before any code is sent to it.
// Returns null when the number is free, or a message explaining why not.
async function checkPhoneAvailable(canonicalPhone, ownEmail) {
  if (!canonicalPhone) return null
  const mine = String(ownEmail || '').toLowerCase().trim()
  const holders = (await UserRepo.findAllByPhone(canonicalPhone))
    .filter(u => String(u.email || '').toLowerCase() !== mine)
  if (holders.some(u => u.isVerified)) {
    return 'This phone number is already linked to another KebSEND account. Sign in to that account, or use a different number.'
  }
  const now = Date.now()
  const pending = holders.filter(u => u.verificationCodeExpiry && new Date(u.verificationCodeExpiry).getTime() > now)
  if (pending.length) {
    return 'This phone number is waiting to be verified on another sign-up. Use the code sent to it on that sign-up, or try again in 15 minutes.'
  }
  // Only abandoned, expired sign-ups hold the number: release it.
  for (const u of holders) await UserRepo.clearPhone(u._id || u.id)
  return null
}

async function deliverVerificationCode({ email, name, phone, code }) {
  const promises = []
  promises.push(
    sendVerificationEmail({ to: email, name, code }).catch(err => {
      console.warn('[deliverVerificationCode] Email dispatch error:', err.message)
      return { ok: false, error: err.message }
    })
  )

  if (phone && isGhanaNumber(phone)) {
    promises.push(
      sendSMS({
        to: phone,
        senderId: 'TXTORA',
        message: `Your KebSEND verification code is ${code}. Valid for 15 minutes. Welcome to KebSEND!`
      }).then(r => {
        console.log('[deliverVerificationCode] SMS OTP sent to', phone, '| res:', r?.status || 'ok')
      }).catch(err => {
        console.warn('[deliverVerificationCode] SMS OTP warning:', err.message)
        return null
      })
    )
  }

  await Promise.allSettled(promises)
}

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

// Checks a dashboard SMS send and works out what it costs, without sending.
function prepareDashboardSms(user, body) {
  const { to, message, senderId } = body || {}
  if (!to || !message) {
    return { ok: false, status: 400, data: { ok: false, message: 'Recipients ("to") and "message" are required.' } }
  }
  let recipients = []
  if (Array.isArray(to)) recipients = to.map(normalizeNumber).filter(Boolean)
  else if (typeof to === 'string') recipients = to.split(/[\n,;]+/).map(normalizeNumber).filter(Boolean)
  if (recipients.length === 0) {
    return { ok: false, status: 400, data: { ok: false, message: 'No valid recipient phone numbers provided.' } }
  }
  // Authorize the sender ID: callers may only use IDs approved for their own account.
  const allowedList = allowedSenderIdsFor(user)
  if (allowedList.length === 0) {
    return { ok: false, status: 403, data: { ok: false, noSenderId: true, message: 'You don\'t have an approved sender ID yet. Register one under Sender IDs first.' } }
  }
  const sId = senderId ? String(senderId).trim() : allowedList[0]
  if (!allowedList.includes(sId.toUpperCase())) {
    return { ok: false, status: 403, data: { ok: false, message: `Sender ID "${sId}" is not approved for your account. Register it under Sender IDs first.` } }
  }
  const unitsPerMessage = calculateSMSUnits(message)
  let needed = 0
  for (const r of recipients) needed += isGhanaNumber(r) ? unitsPerMessage * 1.0 : unitsPerMessage * 1.6
  return { ok: true, recipients, message: String(message), senderId: sId, needed: Number(needed.toFixed(2)) }
}

// Debits the SMS wallet and sends. Refunds if the carrier call fails.
async function sendDashboardSms(user, prep) {
  const { recipients, message, senderId: sId, needed: totalCreditsNeeded } = prep
  const userId = user._id || user.id
  const debitRes = await UserRepo.debitBalance(userId, totalCreditsNeeded)
  if (!debitRes.ok) {
    return { status: 400, data: {
      ok: false,
      message: `Insufficient balance. Required: ${totalCreditsNeeded} credits, Available: ${debitRes.balance} credits. Please recharge your wallet.`,
      requiredCredits: totalCreditsNeeded,
      currentBalance: debitRes.balance
    } }
  }

  let arkeselRes
  try {
    arkeselRes = await sendSMS({ to: recipients, message, senderId: sId })
  } catch (sendErr) {
    // Refund on failure
    await UserRepo.creditBalance(userId, totalCreditsNeeded)
    return { status: 500, data: { ok: false, message: 'Carrier sending failed: ' + sendErr.message } }
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

  return { status: 200, data: {
    ok: true,
    message: `SMS dispatched to ${recipients.length} recipients successfully.`,
    units_debited: totalCreditsNeeded,
    remaining_balance: debitRes.balance,
    data: arkeselRes,
    log: logEntry
  } }
}

// Pay-as-you-go SMS: runs once the payment is confirmed.
payg.setDispatcher('sms', async (user, payload) => {
  const prep = prepareDashboardSms(user, payload)
  if (!prep.ok) throw new Error(prep.data.message)
  const out = await sendDashboardSms(user, prep)
  if (!out.data.ok) throw new Error(out.data.message)
  return { recipients: prep.recipients.length, units: out.data.units_debited, remainingBalance: out.data.remaining_balance }
})

function baseUrlOf(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  const proto = String(req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http')).split(',')[0].trim()
  return `${proto}://${req.headers.host || 'localhost:4000'}`
}

// Connect to MongoDB
connectDB().catch(err => console.error('DB Startup error:', err.message))

// KebSEND Email background worker (outbox + domain re-checks)
emailEngine.startWorker()

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

  // --------------------------------------------------------------------------
  // PAYSTACK WEBHOOK (INSTANT SERVER-TO-SERVER PAYMENT NOTIFICATION)
  // --------------------------------------------------------------------------
  if ((urlPath === '/api/webhook/paystack' || urlPath === '/paystack/webhook') && req.method === 'POST') {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks)
      const signature = req.headers['x-paystack-signature']
      const secret = process.env.PAYSTACK_SECRET_KEY || ''
      if (!secret) {
        res.writeHead(500)
        return res.end('Paystack secret unconfigured')
      }
      const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex')
      if (hash !== signature) {
        res.writeHead(401)
        return res.end('Invalid signature')
      }
      res.writeHead(200)
      res.end('OK')

      try {
        const event = JSON.parse(rawBody.toString('utf8'))
        if (event.event === 'charge.success') {
          const data = event.data || {}
          const reference = data.reference
          if (reference && reference.startsWith('web_topup_')) {
            const tx = await TransactionRepo.findByReference(reference)
            if (tx && tx.status !== 'success') {
              const transitioned = await TransactionRepo.markSuccess(reference)
              if (transitioned) {
                await UserRepo.creditBalance(tx.userId, tx.credits)
                console.log(`[PAYSTACK WEBHOOK] Credited ${tx.credits} SMS to user ${tx.userId} for ref ${reference}`)
              }
            }
          } else if (reference && reference.startsWith(emailWallet.REF_PREFIX)) {
            // Email credits go to the separate email balance, never to SMS.
            const result = await emailWallet.fulfillPurchase(reference)
            console.log(`[PAYSTACK WEBHOOK] Email credits for ref ${reference}:`, result.ok ? (result.already ? 'already credited' : `+${result.emails} ${result.product}`) : result.reason)
          } else if (reference && reference.startsWith(payg.REF_PREFIX)) {
            // Pay as you go: the customer may have closed the tab, so send it from here.
            const result = await payg.fulfill(reference)
            console.log(`[PAYSTACK WEBHOOK] Pay-as-you-go ${reference}:`, result.ok ? result.order.status : result.reason)
          } else if (reference && reference.startsWith('sid_fee_')) {
            // Paystack already told us it's paid (signed webhook), so create the
            // request and alert the admin here; don't wait for the customer to return.
            const result = await fulfillSenderIdFee(reference, { verified: true })
            console.log(`[PAYSTACK WEBHOOK] Sender ID fee for ref ${reference}:`, result.created ? 'request created' : (result.reason || 'already recorded'))
          }
        }
      } catch (err) {
        console.error('[PAYSTACK WEBHOOK ERROR]', err)
      }
    })
    return
  }

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
        if (t.startsWith('ksnd_') || t.startsWith('txt_')) key = t
      }
    }
    if (!key) return null

    // 1. Check web ApiKeyRepo
    const apiKeyDoc = await ApiKeyRepo.findByKey(key)
    if (apiKeyDoc) {
      const user = await UserRepo.findById(apiKeyDoc.userId)
      if (user) return { apiKeyDoc, user, isBotDev: false }
    }

    // 2. Cross-check bot_api_developers in MongoDB Atlas
    try {
      const { mongoose, connectDB, getMongoStatus } = require('./src/db')
      if (!getMongoStatus || !getMongoStatus() || mongoose.connection?.readyState !== 1) {
        await connectDB().catch(() => {})
      }
      const db = mongoose.connection.db || mongoose.connection.client?.db()
      if (db) {
        const botDev = await db.collection('bot_api_developers').findOne({
          $or: [{ apiKey: key }, { apiKeys: key }]
        })
        if (botDev) {
          const sidsDoc = await db.collection('bot_sender_ids').findOne({ userId: String(botDev.userId) })
          const syntheticUser = {
            _id: 'bot_' + botDev.userId,
            id: 'bot_' + botDev.userId,
            userId: String(botDev.userId),
            name: botDev.name || 'Bot Developer',
            email: `tg_${botDev.userId}@t.me`,
            balance: botDev.balance || 0,
            senderIds: (sidsDoc && Array.isArray(sidsDoc.senderIds) && sidsDoc.senderIds.length > 0) ? sidsDoc.senderIds : ['TXTORA'],
            isBotDev: true
          }
          return {
            apiKeyDoc: { key, userId: syntheticUser.id, name: botDev.name },
            user: syntheticUser,
            isBotDev: true,
            botDev
          }
        }
      }
    } catch (e) {
      console.warn('[authenticateApiKey cross-check failed]', e.message)
    }

    return null
  }

  // --------------------------------------------------------------------------
  // KEBSEND EMAIL (all routes live in src/email)
  // --------------------------------------------------------------------------
  if (await handleEmailRoutes(req, res, { urlPath, urlObj, json, authenticateUser, authenticateApiKey })) return

  // --------------------------------------------------------------------------
  // AUTHENTICATION ROUTES
  // --------------------------------------------------------------------------

  if (urlPath === '/api/auth/register' && req.method === 'POST') {
    try {
      const rl = rateLimit('register:' + clientIp(req), 10, 60 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many sign-up attempts. Please try again later.' })
      const body = await parseBody()
      const { name, email, password } = body
      if (!name || !email || !password) {
        return json(400, { ok: false, message: 'Name, email, and password are required.' })
      }
      if (password.length < 6) {
        return json(400, { ok: false, message: 'Password must be at least 6 characters long.' })
      }
      let phone = ''
      if (body.phone && String(body.phone).trim()) {
        phone = toCanonicalGhanaPhone(body.phone)
        if (!phone) {
          return json(400, { ok: false, message: 'Please enter a valid Ghana mobile number, like 024 400 0123.' })
        }
      }

      const existing = await UserRepo.findByEmail(email)
      if (existing) {
        if (existing.isVerified) {
          return json(400, { ok: false, message: 'An account with this email already exists.' })
        }
        const phoneProblem = await checkPhoneAvailable(phone, email)
        if (phoneProblem) return json(409, { ok: false, message: phoneProblem })
        // Account exists but was not yet verified: refresh credentials and send a new OTP code
        const code = Math.floor(100000 + Math.random() * 900000).toString()
        const expiry = new Date(Date.now() + 15 * 60 * 1000)
        const passwordHash = await hashPassword(password)
        await UserRepo.updateUnverifiedUser(existing._id || existing.id, { name, phone, passwordHash, code, expiry })
        await deliverVerificationCode({ email, name, phone, code })

        return json(200, {
          ok: true,
          requiresVerification: true,
          email: existing.email,
          message: 'Account pending verification. A fresh 6-digit code has been sent to your email and phone via SMS.'
        })
      }

      const phoneProblem = await checkPhoneAvailable(phone, email)
      if (phoneProblem) return json(409, { ok: false, message: phoneProblem })

      const passwordHash = await hashPassword(password)
      const code = Math.floor(100000 + Math.random() * 900000).toString()
      const expiry = new Date(Date.now() + 15 * 60 * 1000)

      const user = await UserRepo.create({
        name,
        email,
        phone,
        passwordHash,
        initialBalance: 0, // 0 credits until email code is verified!
        isVerified: false,
        verificationCode: code,
        verificationCodeExpiry: expiry
      })

      await deliverVerificationCode({ email, name, phone, code })

      return json(200, {
        ok: true,
        requiresVerification: true,
        email: user.email,
        message: 'Account created! Please enter the 6-digit verification code sent to your email and phone via SMS.'
      })
    } catch (err) {
      console.error('[register error]', err)
      return json(500, { ok: false, message: 'Something went wrong creating your account.' })
    }
  }

  if (urlPath === '/api/auth/verify-code' && req.method === 'POST') {
    try {
      const rl = rateLimit('verify:' + clientIp(req), 15, 15 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many verification attempts. Please wait.' })
      const body = await parseBody()
      const { email, code } = body
      if (!email || !code) {
        return json(400, { ok: false, message: 'Email and 6-digit verification code are required.' })
      }

      // Last check before the account goes live: another account may have
      // verified this number since the code was sent.
      const pendingUser = await UserRepo.findByEmail(email)
      if (pendingUser && !pendingUser.isVerified && pendingUser.phone) {
        const canonical = toCanonicalGhanaPhone(pendingUser.phone)
        if (canonical) {
          const taken = (await UserRepo.findAllByPhone(canonical))
            .some(u => u.isVerified && String(u.email).toLowerCase() !== String(pendingUser.email).toLowerCase())
          if (taken) {
            return json(409, { ok: false, message: 'This phone number is already linked to another KebSEND account. Please sign up again with a different number.' })
          }
        }
      }

      const result = await UserRepo.verifyUserEmail(email, code)
      if (!result.ok) {
        return json(400, { ok: false, message: result.message || 'Invalid or expired code.' })
      }

      const user = result.user
      // Ensure initial default API key exists
      let keys = await ApiKeyRepo.listByUser(user._id || user.id)
      let initialKey = keys && keys[0]
      if (!initialKey) {
        initialKey = await ApiKeyRepo.generate(user._id || user.id, 'Initial Default Key')
      }

      const token = generateToken(user)
      return json(200, {
        ok: true,
        message: 'Email verified successfully! Please top up your wallet to start sending SMS.',
        token,
        user: {
          id: user._id || user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          balance: user.balance,
          senderIds: allowedSenderIdsFor(user)
        },
        initialApiKey: initialKey?.key
      })
    } catch (err) {
      if (err && err.code === 11000) {
        return json(409, { ok: false, message: 'This phone number is already linked to another KebSEND account. Please sign up again with a different number.' })
      }
      console.error('[verify-code error]', err)
      return json(500, { ok: false, message: 'Failed to verify code.' })
    }
  }

  if (urlPath === '/api/auth/resend-code' && req.method === 'POST') {
    try {
      const rl = rateLimit('resend:' + clientIp(req), 5, 15 * 60 * 1000)
      if (!rl.ok) return json(429, { ok: false, message: 'Too many requests. Please wait a minute.' })
      const body = await parseBody()
      const { email } = body
      if (!email) return json(400, { ok: false, message: 'Email is required.' })

      const user = await UserRepo.findByEmail(email)
      if (!user) {
        return json(404, { ok: false, message: 'No account found with this email.' })
      }
      if (user.isVerified) {
        return json(400, { ok: false, message: 'This account is already verified. Please sign in.' })
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString()
      const expiry = new Date(Date.now() + 15 * 60 * 1000)
      await UserRepo.setVerificationCode(user.email, code, expiry)
      await deliverVerificationCode({ email: user.email, name: user.name, phone: user.phone, code })

      return json(200, { ok: true, message: 'A new 6-digit verification code has been sent to your email and phone via SMS.' })
    } catch (err) {
      console.error('[resend-code error]', err)
      return json(500, { ok: false, message: 'Failed to resend verification code.' })
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

      if (user.isVerified === false) {
        let code = user.verificationCode
        let expiry = user.verificationCodeExpiry
        if (!code || !expiry || new Date(expiry) <= new Date()) {
          code = Math.floor(100000 + Math.random() * 900000).toString()
          expiry = new Date(Date.now() + 15 * 60 * 1000)
          await UserRepo.setVerificationCode(user.email, code, expiry)
        }
        await deliverVerificationCode({ email: user.email, name: user.name, phone: user.phone, code })

        return json(403, {
          ok: false,
          requiresVerification: true,
          email: user.email,
          message: 'Please verify your account to continue. A 6-digit code has been sent to your email and phone via SMS.'
        })
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
          senderIds: allowedSenderIdsFor(user)
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
        freeSenderIdRetries: Number(user.freeSenderIdRetries || 0),
        senderIds: allowedSenderIdsFor(user)
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
    const apiKeys = await ApiKeyRepo.listByUser(userId, 'sms')
    const logs = await SmsLogRepo.listByUser(userId, 10)
    // Catch sender ID fees paid on Paystack where the customer never came back to the site.
    try { await reconcileUserSenderIdFees(userId) } catch (e) { console.warn('[Sender ID Reconcile]', e.message) }
    const senderIdRequests = await SenderIdRequestRepo.listByUser(userId)

    const feeGHS = 0

    return json(200, {
      ok: true,
      customSenderIdFeeGHS: feeGHS,
      paygSmsGHS: payg.rates().sms,
      user: {
        id: userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        balance: user.balance,
        freeSenderIdRetries: Number(user.freeSenderIdRetries || 0),
        senderIds: allowedSenderIdsFor(user)
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
    const prep = prepareDashboardSms(user, body)
    if (!prep.ok) return json(prep.status, prep.data)
    const out = await sendDashboardSms(user, prep)
    if (!out.data.ok && out.data.requiredCredits !== undefined) {
      // Short of credits: offer to pay for just this send.
      out.data.payg = payg.quote('sms', out.data.requiredCredits, out.data.currentBalance)
    }
    return json(out.status, out.data)
  }

  // Pay as you go: open a Paystack checkout for the credits this send is short of.
  // The send itself goes out once the payment is confirmed (webhook or verify below).
  if (urlPath === '/api/dashboard/payg/sms' && req.method === 'POST') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })
    if (!rateLimit('payg:' + (user._id || user.id), 10, 60 * 1000).ok) return json(429, { ok: false, message: 'Too many checkout attempts. Please wait a minute.' })
    const body = await parseBody()
    const prep = prepareDashboardSms(user, body)
    if (!prep.ok) return json(prep.status, prep.data)
    const q = payg.quote('sms', prep.needed, user.balance)
    if (!q) return json(409, { ok: false, enough: true, message: 'You have enough credits for this send. Press Send to send it.' })
    const { reference } = await payg.createOrder({ user, kind: 'sms', product: 'sms', quote: q, payload: { to: prep.recipients, message: prep.message, senderId: prep.senderId } })
    let payment
    try {
      payment = await initializePayment({ email: user.email, amountGHS: q.amountGHS, reference, callbackUrl: `${baseUrlOf(req)}/#dashboard?ref=${reference}` })
    } catch (e) {
      console.error('[PAYG] Paystack init failed', e.message)
    }
    const checkoutUrl = payment?.data?.authorization_url
    if (!checkoutUrl) return json(502, { ok: false, message: 'Could not open Paystack checkout. Please try again.' })
    return json(200, { ok: true, reference, quote: q, checkout_url: checkoutUrl })
  }

  // Pay as you go (SMS and email): confirm the payment, then the send goes out once.
  if (urlPath === '/api/payg/verify' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })
    const reference = String(urlObj.searchParams.get('reference') || '')
    const r = await payg.fulfill(reference, {
      userId: user._id || user.id,
      confirm: async () => {
        const v = await verifyPayment(reference).catch(() => null)
        return !!(v && v.status && v.data?.status === 'success')
      }
    })
    if (!r.ok) return json(404, { ok: false, message: 'Payment not found.' })
    return json(200, { ok: true, order: r.order })
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

    // Only SMS top-ups belong to this user's SMS wallet. Email credit and sender ID
    // payments are settled by their own endpoints.
    const tx = await TransactionRepo.findByReference(reference)
    if (!tx || !String(reference).startsWith('web_topup_') || String(tx.userId) !== String(user._id || user.id)) {
      return json(404, { ok: false, message: 'Transaction not found' })
    }

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
    const r = await requestWebSenderId({ user, senderId: body.senderId, purpose: body.purpose })
    return json(r.status, r.body)
  }

  if (urlPath === '/api/dashboard/sender-id/verify-payment' && req.method === 'GET') {
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })

    const reference = urlObj.searchParams.get('reference')
    if (!reference) return json(400, { ok: false, message: 'Missing transaction reference' })

    const tx = await TransactionRepo.findByReference(reference)
    if (!tx || String(tx.userId) !== String(user._id || user.id)) {
      return json(404, { ok: false, message: 'Transaction not found' })
    }

    let result
    try {
      result = await fulfillSenderIdFee(reference)
    } catch (err) {
      console.error('[Sender ID verify-payment]', err.message)
      return json(500, { ok: false, message: 'Could not complete sender ID payment verification.' })
    }
    if (!result.ok) {
      return json(400, { ok: false, message: 'Payment verification pending or failed.' })
    }
    return json(200, {
      ok: true,
      message: result.created
        ? `Payment confirmed! Sender ID "${result.senderId}" submitted for review. It will be approved shortly.`
        : `Sender ID "${result.senderId}" payment already confirmed and submitted for review.`,
      senderId: result.senderId,
      senderIdRequest: result.request
    })
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

    // Email-only keys can't use the SMS API.
    if (!auth.isBotDev && !keyHasScope(auth.apiKeyDoc, 'sms')) {
      return json(403, { ok: false, message: 'This API key is for KebSEND Email. Use an SMS API key from the Developers tab.' })
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

    // List this account's sender IDs: the approved ones it can send from, plus
    // every request with its status (pending / approved / rejected).
    if (urlPath === '/api/v1/sender-ids' && req.method === 'GET') {
      const requests = user.isBotDev ? [] : await SenderIdRequestRepo.listByUser(userId)
      return json(200, {
        ok: true,
        senderIds: allowedSenderIdsFor(user),
        requests: requests.map(r => ({
          senderId: r.senderId,
          status: r.status,
          purpose: r.purpose || '',
          requestedAt: r.createdAt,
          reviewedAt: r.reviewedAt || null
        }))
      })
    }

    // Request a new sender ID (free). It goes to the KebSEND admin in Telegram
    // and can be used for sending only after it's approved.
    if (urlPath === '/api/v1/sender-ids' && req.method === 'POST') {
      if (user.isBotDev) {
        return json(400, { ok: false, message: 'Telegram developer keys request sender IDs in the KebSEND Telegram bot.' })
      }
      const body = await parseBody()
      const r = await requestWebSenderId({ user, senderId: body.senderId, purpose: body.purpose })
      if (r.body.senderIdRequest) {
        const q = r.body.senderIdRequest
        r.body.senderIdRequest = { senderId: q.senderId, status: q.status, purpose: q.purpose, requestedAt: q.createdAt }
      }
      return json(r.status === 200 ? 201 : r.status, r.body)
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

        const allowedList = allowedSenderIdsFor(user)
        if (allowedList.length === 0) {
          return json(403, { ok: false, message: 'No approved sender ID on this account yet. Register one under Sender IDs on your dashboard.' })
        }
        const sId = senderId ? String(senderId).trim() : allowedList[0]
        if (!allowedList.includes(sId.toUpperCase())) {
          return json(403, { ok: false, message: `Sender ID "${sId}" is not approved for your account.` })
        }

        const msgUnits = calculateSMSUnits(message)
        let totalCreditsNeeded = 0
        for (const r of recipients) {
          totalCreditsNeeded += isGhanaNumber(r) ? msgUnits * 1.0 : msgUnits * 1.6
        }
        totalCreditsNeeded = Number(totalCreditsNeeded.toFixed(2))

        let debitRes
        if (auth.isBotDev) {
          const { mongoose } = require('./src/db')
          const coll = mongoose.connection.db.collection('bot_api_developers')
          const currentDev = await coll.findOne({
            $or: [{ apiKey: auth.apiKeyDoc.key }, { apiKeys: auth.apiKeyDoc.key }]
          })
          if (!currentDev || (currentDev.balance || 0) < totalCreditsNeeded) {
            return json(400, { ok: false, message: 'Insufficient balance', balance: currentDev?.balance || 0 })
          }
          const newBal = Number(((currentDev.balance || 0) - totalCreditsNeeded).toFixed(2))
          await coll.updateOne({ _id: currentDev._id }, { $set: { balance: newBal, updatedAt: new Date() } })
          debitRes = { ok: true, balance: newBal }
        } else {
          debitRes = await UserRepo.debitBalance(userId, totalCreditsNeeded)
        }

        if (!debitRes.ok) {
          return json(400, { ok: false, message: debitRes.message || 'Insufficient balance', balance: debitRes.balance })
        }

        let sendRes
        try {
          sendRes = await sendSMS({ to: recipients, message, senderId: sId })
        } catch (err) {
          if (auth.isBotDev) {
            const { mongoose } = require('./src/db')
            await mongoose.connection.db.collection('bot_api_developers').updateOne(
              { $or: [{ apiKey: auth.apiKeyDoc.key }, { apiKeys: auth.apiKeyDoc.key }] },
              { $inc: { balance: totalCreditsNeeded } }
            )
          } else {
            await UserRepo.creditBalance(userId, totalCreditsNeeded)
          }
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
      pricing: { localGHS: 0.05, internationalGHS: 0.08, customSenderIdFeeGHS: 0, genericSenderId: 'TXTORA' },
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
  if (safePath === '/email' || safePath === '/email/') safePath = '/email.html'

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
