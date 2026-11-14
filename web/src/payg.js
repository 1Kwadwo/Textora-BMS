// Pay as you go: on the website dashboard, a send that is short of credits can be
// paid for on the spot (Paystack), and goes out as soon as the payment clears.
// The payment buys exactly the credits the send is short of, then the send runs through the normal
// path, so refunds and logs work the same way. The API never offers this:
// API sends always need credits from a package.
const crypto = require('crypto')
const { db } = require('./email/store')
const { TransactionRepo, UserRepo } = require('./models')

const REF_PREFIX = 'web_payg_'

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
// SMS uses the normal business model: one SMS credit is GH₵ 0.05 (the same as
// every SMS package), and a send uses the same units as any send (contacts x
// SMS parts, 1.6 per part abroad).
const SMS_CREDIT_GHS = 0.05
// GHS per credit (one SMS unit, or one email to one person).
function rates() {
  return {
    sms: SMS_CREDIT_GHS,
    transactional: num(process.env.PAYG_EMAIL_TRANSACTIONAL_GHS, 0.04),
    marketing: num(process.env.PAYG_EMAIL_MARKETING_GHS, 0.03)
  }
}
// Smallest single email payment. SMS has none: one SMS costs GH₵ 0.05.
const minGHS = () => num(process.env.PAYG_MIN_GHS, 1)

const round2 = n => Math.round(n * 100) / 100

// What it costs to pay for the part of a send the balance does not cover.
function quote(product, needed, balance) {
  const rate = rates()[product]
  if (!rate) throw new Error('Unknown pay-as-you-go product ' + product)
  const short = Math.max(0, Number(needed) - Math.max(0, Number(balance) || 0))
  if (!(short > 0.0001)) return null
  if (product === 'sms') {
    // Exactly the units this send is short of, at the normal SMS price.
    const credits = round2(short)
    const amountGHS = Math.max(0.01, Math.ceil(credits * rate * 100 - 1e-9) / 100)
    return { product, needed: Number(needed), balance: Number(balance) || 0, credits, rateGHS: rate, amountGHS, minGHS: 0 }
  }
  let credits = Math.ceil(short - 1e-9)
  if (credits * rate < minGHS()) credits = Math.ceil(minGHS() / rate - 1e-9)
  return { product, needed: Number(needed), balance: Number(balance) || 0, credits, rateGHS: rate, amountGHS: round2(credits * rate), minGHS: minGHS() }
}

async function createOrder({ user, kind, product, quote: q, payload, baseUrl }) {
  const userId = String(user._id || user.id)
  const reference = REF_PREFIX + Date.now() + '_' + crypto.randomBytes(4).toString('hex')
  await TransactionRepo.create({
    userId,
    reference,
    amountGHS: q.amountGHS,
    credits: q.credits,
    paymentPurpose: kind === 'sms' ? `payg_sms:${q.credits}` : `email_payg:${product}:${q.credits}`
  })
  await db.payg.insert({ reference, userId, kind, product, credits: q.credits, amountGHS: q.amountGHS, payload, baseUrl: baseUrl || null, status: 'pending', result: null, error: null })
  return { reference }
}

function view(order) {
  return { reference: order.reference, kind: order.kind, product: order.product, status: order.status, credits: order.credits, amountGHS: order.amountGHS, result: order.result || null, message: order.error || null }
}

const dispatchers = {}
// kind -> async (user, payload, order) => result summary; throws on failure.
function setDispatcher(kind, fn) { dispatchers[kind] = fn }

// Settle a pay-as-you-go order exactly once: add the credits it bought, then send.
// `confirm` runs only while the payment is still pending and must resolve true
// when Paystack says it's paid (the signed webhook passes no confirm).
async function fulfill(reference, { userId = null, confirm } = {}) {
  if (!String(reference || '').startsWith(REF_PREFIX)) return { ok: false, reason: 'not_found' }
  const order = await db.payg.findOne({ reference })
  if (!order || (userId && String(order.userId) !== String(userId))) return { ok: false, reason: 'not_found' }
  if (order.status !== 'pending') return { ok: true, order: view(order) }

  const tx = await TransactionRepo.findByReference(reference)
  if (!tx) return { ok: false, reason: 'not_found' }
  if (tx.status === 'success') return { ok: true, order: view(order) } // another request is sending it
  if (confirm && !(await confirm())) return { ok: true, order: view(order) }
  if (!(await TransactionRepo.markSuccess(reference))) return { ok: true, order: view(order) }

  // Paid. The credits go in first, so they are never lost if the send fails.
  if (order.kind === 'sms') await UserRepo.creditBalance(order.userId, order.credits)
  else await require('./email/wallet').credit(order.userId, order.product, order.credits)
  await db.payg.updateOne({ reference, status: 'pending' }, { $set: { status: 'paid', paidAt: new Date().toISOString() } })

  let set
  try {
    const user = await UserRepo.findById(order.userId)
    if (!user) throw new Error('Account not found.')
    const dispatch = dispatchers[order.kind]
    if (!dispatch) throw new Error('Sending is not available right now.')
    const result = await dispatch(user, order.payload, order)
    set = { status: 'sent', result, payload: null }
  } catch (err) {
    set = { status: 'failed', error: `Payment received and the credits are in your balance, but the send did not go out: ${err.message}` }
    console.warn('[PAYG] send failed after payment', reference, err.message)
  }
  const done = await db.payg.updateOne({ reference }, { $set: { ...set, finishedAt: new Date().toISOString() } })
  return { ok: true, order: view(done || { ...order, ...set }) }
}


module.exports = { REF_PREFIX, rates, minGHS, quote, createOrder, fulfill, setDispatcher, view }
