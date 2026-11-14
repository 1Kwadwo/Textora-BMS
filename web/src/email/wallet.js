// Email credits: kept apart from the SMS wallet (User.balance).
// One email credit = one email to one recipient. Transactional and marketing
// credits are two balances on the user's email account record, bought with
// the same Paystack checkout as SMS.
const { db } = require('./store')
const { TransactionRepo } = require('../models')
const pricing = require('./pricing')

const FIELD = { transactional: 'txCredits', marketing: 'mkCredits' }
const REF_PREFIX = 'web_email_'

const freeTrial = () => Math.max(0, Math.floor(Number(process.env.EMAIL_FREE_TRANSACTIONAL ?? 25)))

function field(product) {
  const f = FIELD[product]
  if (!f) throw new Error('Unknown email product ' + product)
  return f
}

// Make sure the user has an email account record with numeric balances.
// New accounts get a small free transactional allowance to test with.
async function ensureAccount(userId) {
  userId = String(userId)
  let acc = await db.accounts.findOne({ userId })
  if (!acc) {
    try {
      acc = await db.accounts.insert({ userId, paused: false, txCredits: freeTrial(), mkCredits: 0, trialGranted: freeTrial() })
    } catch (err) {
      if (!/duplicate key/i.test(err.message)) throw err
      acc = await db.accounts.findOne({ userId })
    }
  }
  // Older account records (made before email credits existed) get zero balances.
  for (const k of ['txCredits', 'mkCredits']) {
    if (typeof acc[k] === 'number') continue
    acc = (await db.accounts.updateOne({ userId, [k]: { $exists: false } }, { $set: { [k]: 0 } })) || (await db.accounts.findOne({ userId }))
  }
  return acc
}

async function balances(userId) {
  const acc = await ensureAccount(userId)
  return { transactional: Number(acc.txCredits || 0), marketing: Number(acc.mkCredits || 0) }
}

// Atomic: only takes the credits if the balance covers them.
async function debit(userId, product, amount) {
  const f = field(product)
  await ensureAccount(userId)
  amount = Math.floor(Number(amount))
  if (!(amount > 0)) return { ok: true, balance: (await balances(userId))[product] }
  const updated = await db.accounts.updateOne({ userId: String(userId), [f]: { $gte: amount } }, { $inc: { [f]: -amount } })
  if (!updated) return { ok: false, balance: (await balances(userId))[product] }
  return { ok: true, balance: Number(updated[f]) }
}

async function credit(userId, product, amount) {
  const f = field(product)
  await ensureAccount(userId)
  amount = Math.floor(Number(amount))
  if (!(amount > 0)) return { ok: true, balance: (await balances(userId))[product] }
  const updated = await db.accounts.updateOne({ userId: String(userId) }, { $inc: { [f]: amount } })
  return { ok: true, balance: Number(updated?.[f] || 0) }
}

// ---------------------------------------------------------------- purchases

function parsePurpose(purpose) {
  const m = String(purpose || '').match(/^email_(?:credits|payg):(transactional|marketing):([A-Za-z0-9_-]+)$/)
  return m ? { product: m[1], packId: m[2] } : null
}

async function createPurchase(user, product, packId) {
  const pack = pricing.findPack(product, packId)
  if (!pack) return null
  const reference = REF_PREFIX + Date.now() + '_' + require('crypto').randomBytes(4).toString('hex')
  await TransactionRepo.create({
    userId: String(user._id || user.id),
    reference,
    amountGHS: pack.priceGHS,
    credits: pack.emails,
    paymentPurpose: `email_credits:${product}:${pack.id}`
  })
  return { reference, pack }
}

// Credit a paid purchase exactly once. `confirm` is called only while the
// transaction is still pending and must resolve true when Paystack says it's paid.
async function fulfillPurchase(reference, { userId = null, confirm } = {}) {
  if (!String(reference || '').startsWith(REF_PREFIX)) return { ok: false, reason: 'not_email_purchase' }
  const tx = await TransactionRepo.findByReference(reference)
  if (!tx) return { ok: false, reason: 'not_found' }
  if (userId && String(tx.userId) !== String(userId)) return { ok: false, reason: 'not_found' }
  const what = parsePurpose(tx.paymentPurpose)
  if (!what) return { ok: false, reason: 'not_email_purchase' }
  if (tx.status === 'success') return { ok: true, already: true, product: what.product, emails: tx.credits, tx }
  if (confirm && !(await confirm(tx))) return { ok: false, reason: 'not_paid', product: what.product }
  const flipped = await TransactionRepo.markSuccess(reference)
  if (!flipped) return { ok: true, already: true, product: what.product, emails: tx.credits, tx }
  const res = await credit(tx.userId, what.product, tx.credits)
  console.log(`[Email credits] +${tx.credits} ${what.product} for user ${tx.userId} (ref ${reference})`)
  return { ok: true, product: what.product, emails: tx.credits, balance: res.balance, tx }
}

async function purchaseHistory(userId, limit = 20) {
  const txs = await TransactionRepo.listByUser(userId, 100)
  return txs
    .map(t => ({ t, what: parsePurpose(t.paymentPurpose) }))
    .filter(x => x.what && (x.t.status === 'success' || x.t.status === 'pending'))
    .slice(0, limit)
    .map(({ t, what }) => ({
      reference: t.reference,
      product: what.product,
      emails: Number(t.credits),
      amountGHS: Number(t.amountGHS),
      status: t.status,
      createdAt: t.createdAt
    }))
}

async function hasPaid(userId) {
  const txs = await TransactionRepo.listByUser(userId, 100)
  return txs.some(t => t.status === 'success' && parsePurpose(t.paymentPurpose))
}

module.exports = { balances, debit, credit, ensureAccount, createPurchase, fulfillPurchase, purchaseHistory, hasPaid, parsePurpose, REF_PREFIX, freeTrial }
