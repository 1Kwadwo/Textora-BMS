// Shared logic for custom sender ID requests made on the web dashboard.
// Used by the web server (wallet + Paystack flows, webhook, dashboard load)
// and by the Telegram bot (admin approve / reject and /pendingsids).

const { UserRepo, TransactionRepo, SenderIdRequestRepo } = require('../models')
const { verifyPayment } = require('./paystack')
const { sendSMS, toCanonicalGhanaPhone } = require('./sms')
const { sendTelegramSenderIdAlert } = require('./telegramAlert')

const SENDER_ID_FEE_PREFIX = 'sid_fee_'

// Carriers only accept plain letters/digits; emoji or symbols get rejected at send time.
function isValidWebSenderId(value) {
  const v = String(value || '').trim()
  return /^[A-Za-z0-9]{3,11}$/.test(v) && !/^\d+$/.test(v)
}

// The shared generic sender ID (TXTORA) is no longer handed to every account.
// Only these emails keep it automatically (comma-separated env override).
function genericSenderId() {
  return String(process.env.GENERIC_SENDER_ID || 'TXTORA').trim().toUpperCase()
}
function genericSenderAllowedEmails() {
  return String(process.env.GENERIC_SENDER_ALLOWED_EMAILS || 'harrisbraimah@icloud.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
}

// Sender IDs an account may actually send from (upper-cased, no duplicates).
function allowedSenderIdsFor(user) {
  if (!user) return []
  const generic = genericSenderId()
  const ids = (user.senderIds || []).map(x => String(x).trim().toUpperCase()).filter(Boolean)
  const mayUseGeneric = user.isBotDev || genericSenderAllowedEmails().includes(String(user.email || '').toLowerCase())
  const list = ids.filter(id => id !== generic || mayUseGeneric)
  if (mayUseGeneric && !list.includes(generic)) list.push(generic)
  return Array.from(new Set(list))
}

function feeGHS() {
  return Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 8)
}

function parseFeePurpose(paymentPurpose) {
  let senderId = 'CUSTOM'
  let purpose = 'Business Messaging'
  if (paymentPurpose && paymentPurpose.startsWith('sender_id_fee:')) {
    const parts = paymentPurpose.split(':')
    if (parts[1]) senderId = parts[1].toUpperCase()
    if (parts[2]) {
      try { purpose = decodeURIComponent(parts[2]) } catch (e) {}
    }
  }
  return { senderId, purpose }
}

// Creates the pending request for a paid sender ID fee and alerts the admin.
// Safe to call more than once for the same reference: only the call that
// moves the transaction from pending to success creates the request.
async function fulfillSenderIdFee(reference, { verified = false } = {}) {
  if (!reference || !String(reference).startsWith(SENDER_ID_FEE_PREFIX)) return { ok: false, reason: 'not_found' }
  const tx = await TransactionRepo.findByReference(reference)
  if (!tx) return { ok: false, reason: 'not_found' }

  const { senderId, purpose } = parseFeePurpose(tx.paymentPurpose)
  const existing = await SenderIdRequestRepo.findByPaymentReference(reference)
  if (existing) return { ok: true, created: false, senderId, request: existing }

  if (tx.status !== 'success') {
    if (!verified) {
      const res = await verifyPayment(reference)
      if (!(res && res.status && res.data && res.data.status === 'success')) {
        return { ok: false, reason: 'unpaid', senderId, paystackStatus: res?.data?.status }
      }
    }
    await TransactionRepo.markSuccess(reference)
  }

  // Re-check after the transition so two racing callers don't both create one.
  const raced = await SenderIdRequestRepo.findByPaymentReference(reference)
  if (raced) return { ok: true, created: false, senderId, request: raced }

  const request = await SenderIdRequestRepo.create({
    userId: tx.userId,
    senderId,
    purpose,
    feeAmountGHS: tx.amountGHS || feeGHS(),
    paymentMethod: 'paystack',
    paymentReference: reference
  })

  const user = await UserRepo.findById(tx.userId)
  await notifyAdmin({ user, request, paymentMethod: 'Paystack MoMo / Card' })
  return { ok: true, created: true, senderId, request }
}

async function notifyAdmin({ user, request, paymentMethod }) {
  try {
    const sent = await sendTelegramSenderIdAlert({
      user: user || {},
      senderId: request.senderId,
      purpose: request.purpose,
      requestId: String(request._id || request.id),
      feeAmountGHS: request.feeAmountGHS,
      paymentMethod
    })
    return Boolean(sent)
  } catch (err) {
    console.error('[Sender ID Alert Error]', err.message)
    return false
  }
}

// Finds a user's sender ID fee payments that were started but never
// confirmed (the customer paid on MoMo but never came back to the site),
// checks them with Paystack, and turns paid ones into pending requests.
const RECONCILE_INTERVAL_MS = 2 * 60 * 1000
const lastReconcileCheck = new Map()

async function reconcileUserSenderIdFees(userId, { maxAgeHours = 72 } = {}) {
  const since = new Date(Date.now() - maxAgeHours * 3600 * 1000)
  const pending = await TransactionRepo.listPendingByPrefix(SENDER_ID_FEE_PREFIX, { userId, since })
  const results = []
  const now = Date.now()
  for (const tx of pending.slice(0, 3)) {
    // Don't hit Paystack on every dashboard refresh for the same unpaid checkout.
    if (now - (lastReconcileCheck.get(tx.reference) || 0) < RECONCILE_INTERVAL_MS) continue
    lastReconcileCheck.set(tx.reference, now)
    try {
      results.push(await fulfillSenderIdFee(tx.reference))
    } catch (err) {
      console.warn('[Sender ID Reconcile]', tx.reference, err.message)
    }
  }
  return results
}

function senderIdForNotices() {
  return process.env.GENERIC_SENDER_ID || 'TXTORA'
}

async function smsCustomer(user, message) {
  const phone = toCanonicalGhanaPhone(user && user.phone)
  if (!phone) return { ok: false, reason: 'no_phone' }
  try {
    await sendSMS({ to: phone, message, senderId: senderIdForNotices() })
    return { ok: true, phone }
  } catch (err) {
    console.warn('[Sender ID SMS Notice]', err.message)
    return { ok: false, reason: err.message, phone }
  }
}

// Approves or rejects a pending web request. Returns { ok, request, user, sms }.
async function reviewSenderIdRequest(requestId, decision) {
  const status = decision === 'approve' ? 'approved' : 'rejected'
  const current = await SenderIdRequestRepo.findById(requestId)
  if (!current) return { ok: false, reason: 'not_found' }
  if (current.status !== 'pending') return { ok: false, reason: 'already_reviewed', request: current }

  const request = await SenderIdRequestRepo.reviewPending(requestId, status)
  if (!request) {
    const latest = await SenderIdRequestRepo.findById(requestId)
    return { ok: false, reason: 'already_reviewed', request: latest || current }
  }

  if (status === 'approved') {
    await UserRepo.addSenderId(request.userId, request.senderId)
  } else {
    await UserRepo.addFreeSenderIdRetry(request.userId)
  }

  const user = await UserRepo.findById(request.userId)
  const firstName = user && user.name ? String(user.name).trim().split(/\s+/)[0] : ''
  const greeting = firstName ? `Hi ${firstName}, ` : ''
  const message = status === 'approved'
    ? `${greeting}your KebSEND sender ID "${request.senderId}" has been approved. You can now pick it when sending SMS from your dashboard or the API.`
    : `${greeting}your KebSEND sender ID "${request.senderId}" was not approved by the network. Your next sender ID request is free: log in to your dashboard and submit another name (3-11 letters or numbers).`
  const sms = await smsCustomer(user, message)

  return { ok: true, request, user, sms }
}

// Admin: create a sender ID for an account directly and approve it (texts the
// customer). Links it to a paid fee that never became a request, if one exists.
async function grantSenderId({ userId, senderId, purpose = 'Added by KebSEND admin' }) {
  const clean = String(senderId || '').trim().toUpperCase()
  if (!isValidWebSenderId(clean)) return { ok: false, reason: 'invalid' }

  const txs = (await TransactionRepo.listByUser(userId, 50)).filter(t =>
    String(t.reference || '').startsWith(SENDER_ID_FEE_PREFIX) && t.status === 'success')
  let paidTx = null
  for (const t of txs) {
    if (!(await SenderIdRequestRepo.findByPaymentReference(t.reference))) { paidTx = t; break }
  }

  const request = await SenderIdRequestRepo.create({
    userId,
    senderId: clean,
    purpose: paidTx ? parseFeePurpose(paidTx.paymentPurpose).purpose : purpose,
    feeAmountGHS: paidTx ? (paidTx.amountGHS || feeGHS()) : 0,
    paymentMethod: paidTx ? 'paystack' : 'admin',
    paymentReference: paidTx ? paidTx.reference : ''
  })
  const review = await reviewSenderIdRequest(String(request._id || request.id), 'approve')
  return { ...review, linkedPayment: paidTx ? paidTx.reference : null }
}

module.exports = {
  allowedSenderIdsFor,
  genericSenderId,
  genericSenderAllowedEmails,
  isValidWebSenderId,
  grantSenderId,
  SENDER_ID_FEE_PREFIX,
  parseFeePurpose,
  fulfillSenderIdFee,
  notifyAdmin,
  reconcileUserSenderIdFees,
  reviewSenderIdRequest
}
