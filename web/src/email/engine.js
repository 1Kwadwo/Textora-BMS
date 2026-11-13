// KebSEND Email engine: every business rule for email lives here.
// The dashboard, the public API (and later SMTP and bulk campaigns) all call
// these functions. Provider details stay behind ./providers.
const dns = require('dns').promises
const { db, ensureIndexes } = require('./store')
const { getProvider } = require('./providers')
const { UserRepo, TransactionRepo } = require('../models')
const U = require('./util')

class EmailError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

const STATUS_RANK = { queued: 0, accepted: 1, sent: 2, delayed: 3, delivered: 4, bounced: 5, failed: 5, rejected: 5, complained: 6 }
const REFUNDABLE = new Set(['failed', 'rejected'])
const EVENT_TO_STATUS = { sent: 'sent', delivered: 'delivered', delayed: 'delayed', bounced: 'bounced', complained: 'complained', failed: 'failed', suppressed: 'rejected' }
const MAX_ATTEMPTS = 3
const EPOCH = new Date(0).toISOString()

const uid = user => String(user._id || user.id)
const nowIso = () => new Date().toISOString()

function provider() {
  const p = getProvider()
  if (p.name === 'mock' && process.env.NODE_ENV === 'production' && process.env.EMAIL_ALLOW_MOCK !== 'true') {
    throw new EmailError(503, 'email_not_configured', 'Email sending is not configured on this server yet.')
  }
  return p
}

// --------------------------------------------------------------------------
// ACCOUNT HEALTH (abuse protection)
// --------------------------------------------------------------------------

async function getAccount(userId) {
  return (await db.accounts.findOne({ userId: String(userId) })) || { userId: String(userId), paused: false }
}

// Pause sending when bounces or complaints get too high over the last 200 emails.
async function checkHealth(userId) {
  const recent = await db.messages.find({ userId: String(userId), status: { $in: ['delivered', 'bounced', 'complained'] } }, { limit: 200 })
  if (recent.length < 50) return
  const bounced = recent.filter(m => m.status === 'bounced').length / recent.length
  const complained = recent.filter(m => m.status === 'complained').length / recent.length
  let reason = null
  if (bounced > 0.05) reason = `Bounce rate ${(bounced * 100).toFixed(1)}% is above 5%`
  else if (complained > 0.001) reason = `Complaint rate ${(complained * 100).toFixed(2)}% is above 0.1%`
  if (!reason) return
  const existing = await db.accounts.findOne({ userId: String(userId) })
  if (existing?.paused) return
  if (existing) await db.accounts.updateOne({ userId: String(userId) }, { $set: { paused: true, pausedReason: reason, pausedAt: nowIso() } })
  else await db.accounts.insert({ userId: String(userId), paused: true, pausedReason: reason, pausedAt: nowIso() })
  console.warn(`[Email] Paused sending for user ${userId}: ${reason}`)
}

// --------------------------------------------------------------------------
// SENDER DOMAINS
// --------------------------------------------------------------------------

function normalizeDomainName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\.$/, '')
}

function isPlatformDomain(name) {
  const shared = U.config.sharedDomain()
  const platformRoots = [shared, shared.split('.').slice(-2).join('.'), 'kebsend.com']
  return platformRoots.some(root => name === root || name.endsWith('.' + root))
}

function dmarcGuidance(name, found) {
  return {
    purpose: 'DMARC',
    type: 'TXT',
    name: '_dmarc',
    value: `v=DMARC1; p=none; rua=mailto:dmarc-reports@${name}`,
    priority: null,
    ttl: 'Auto',
    optional: true,
    status: found ? 'verified' : 'pending',
    existingValue: found || null
  }
}

async function lookupDmarc(name) {
  try {
    const records = await Promise.race([
      dns.resolveTxt('_dmarc.' + name),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ])
    const hit = records.map(parts => parts.join('')).find(r => /^v=DMARC1/i.test(r))
    return hit || null
  } catch (e) {
    return null
  }
}

function withDmarc(normalized, dmarcFound) {
  const records = normalized.records.filter(r => r.purpose !== 'DMARC')
  records.push(dmarcGuidance(normalized.name, dmarcFound))
  return records
}

async function listDomains(user) {
  return db.domains.find({ userId: uid(user) }, { sort: { createdAt: 1 } })
}

async function addDomain(user, rawName) {
  const name = normalizeDomainName(rawName)
  if (!U.isValidDomain(name)) throw new EmailError(400, 'invalid_domain', 'Enter a domain like company.com (no http:// and no email address).')
  if (isPlatformDomain(name)) throw new EmailError(400, 'platform_domain', 'That domain belongs to KebSEND. Use a shared KebSEND address instead, or add a domain you own.')

  const existing = await db.domains.findOne({ name })
  if (existing) {
    if (existing.userId === uid(user)) return existing
    throw new EmailError(409, 'domain_taken', 'This domain is already connected to another KebSEND account. Contact support if you own it.')
  }
  const max = Number(process.env.EMAIL_MAX_DOMAINS_PER_ACCOUNT || 3)
  if ((await db.domains.count({ userId: uid(user) })) >= max) {
    throw new EmailError(400, 'domain_limit', `You can connect up to ${max} domains. Remove one first.`)
  }

  const p = provider()
  let created
  try {
    created = await p.createDomain(name)
  } catch (err) {
    throw new EmailError(502, 'provider_error', 'Our email provider could not add this domain: ' + err.message)
  }
  return db.domains.insert({
    userId: uid(user),
    name,
    provider: p.name,
    providerDomainId: created.providerDomainId,
    status: created.status,
    region: created.region || null,
    records: withDmarc(created, null),
    lastCheckedAt: nowIso(),
    verifiedAt: created.status === 'verified' ? nowIso() : null
  })
}

async function getOwnedDomain(user, id) {
  const d = await db.domains.findOne({ _id: String(id), userId: uid(user) })
  if (!d) throw new EmailError(404, 'not_found', 'Domain not found.')
  return d
}

async function refreshDomainRecord(d) {
  const p = provider()
  const fresh = await p.verifyDomain(d.providerDomainId)
  const dmarc = await lookupDmarc(d.name)
  const set = { status: fresh.status, records: withDmarc(fresh, dmarc), lastCheckedAt: nowIso() }
  if (fresh.status === 'verified' && !d.verifiedAt) set.verifiedAt = nowIso()
  return db.domains.updateOne({ _id: d._id }, { $set: set })
}

async function refreshDomain(user, id) {
  const d = await getOwnedDomain(user, id)
  try {
    return await refreshDomainRecord(d)
  } catch (err) {
    if (err instanceof EmailError) throw err
    throw new EmailError(502, 'provider_error', 'Could not check the domain right now: ' + err.message)
  }
}

async function removeDomain(user, id) {
  const d = await getOwnedDomain(user, id)
  try {
    await provider().deleteDomain(d.providerDomainId)
  } catch (err) {
    console.warn('[Email] Provider domain delete failed (removing locally anyway):', err.message)
  }
  for (const idt of await db.identities.find({ userId: uid(user), domainId: d._id })) {
    await db.identities.deleteOne({ _id: idt._id })
  }
  await db.domains.deleteOne({ _id: d._id })
  return true
}

// Background: re-check pending domains every few minutes for 3 days.
async function recheckPendingDomains() {
  const cutoff = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  const stale = new Date(Date.now() - 2 * 60 * 1000).toISOString()
  const pending = await db.domains.find({ status: 'pending', createdAt: { $gte: cutoff }, lastCheckedAt: { $lte: stale } }, { limit: 20 })
  for (const d of pending) {
    try { await refreshDomainRecord(d) } catch (e) { console.warn('[Email] Domain re-check failed for', d.name, e.message) }
  }
}

// --------------------------------------------------------------------------
// SENDER IDENTITIES
// --------------------------------------------------------------------------

const RESERVED_HANDLES = new Set(['admin', 'administrator', 'support', 'help', 'noreply', 'no-reply', 'postmaster', 'abuse', 'info', 'billing', 'security', 'kebsend', 'keb', 'hello', 'mail', 'root', 'webmaster', 'hostmaster', 'accounts', 'payments', 'team', 'contact'])

async function listIdentities(user) {
  return db.identities.find({ userId: uid(user) }, { sort: { createdAt: 1 } })
}

async function createIdentity(user, { address, displayName, replyTo, handle }) {
  const shared = U.config.sharedDomain()
  const name = String(displayName || '').trim().slice(0, 80)
  if (/[<>"\\\r\n]/.test(name)) throw new EmailError(400, 'invalid_name', 'The display name cannot contain < > " or \\.')
  let addr
  let domainId = null
  let type
  if (handle !== undefined && handle !== null && handle !== '') {
    const h = String(handle).trim().toLowerCase()
    if (!/^[a-z0-9](?:[a-z0-9.-]{1,30}[a-z0-9])$/.test(h) || h.includes('..')) {
      throw new EmailError(400, 'invalid_handle', 'Use 3 to 32 letters, numbers, dots or dashes, starting and ending with a letter or number.')
    }
    if (RESERVED_HANDLES.has(h)) throw new EmailError(400, 'reserved_handle', 'That name is reserved. Try your organisation name.')
    if ((await db.identities.count({ userId: uid(user), type: 'shared' })) >= 3) {
      throw new EmailError(400, 'identity_limit', 'You can have up to 3 shared KebSEND addresses.')
    }
    addr = `${h}@${shared}`
    type = 'shared'
  } else {
    const mb = U.parseMailbox(address)
    if (!mb) throw new EmailError(400, 'invalid_address', 'Enter a valid email address.')
    addr = mb.address
    const domain = await db.domains.findOne({ userId: uid(user), name: U.domainOf(addr) })
    if (!domain) throw new EmailError(400, 'domain_not_connected', `Add ${U.domainOf(addr)} under Sender domains first.`)
    domainId = domain._id
    type = 'domain'
  }
  let reply = null
  if (replyTo) {
    const r = U.parseMailbox(replyTo)
    if (!r) throw new EmailError(400, 'invalid_reply_to', 'Enter a valid reply-to address.')
    reply = r.address
  }
  if (await db.identities.findOne({ address: addr })) throw new EmailError(409, 'identity_taken', `${addr} is already taken.`)
  const isFirst = (await db.identities.count({ userId: uid(user) })) === 0
  return db.identities.insert({ userId: uid(user), type, address: addr, domainId, displayName: name, replyTo: reply || (type === 'shared' ? user.email : null), isDefault: isFirst })
}

async function removeIdentity(user, id) {
  const ok = await db.identities.deleteOne({ _id: String(id), userId: uid(user) })
  if (!ok) throw new EmailError(404, 'not_found', 'Sender not found.')
  return true
}

// Which "from" addresses can this account use right now?
async function listSenders(user) {
  const [identities, domains] = await Promise.all([listIdentities(user), listDomains(user)])
  const verified = new Set(domains.filter(d => d.status === 'verified').map(d => d._id))
  return identities.map(i => ({
    ...i,
    from: U.formatMailbox({ name: i.displayName, address: i.address }),
    ready: i.type === 'shared' || verified.has(i.domainId)
  }))
}

async function resolveSender(user, fromInput) {
  const mb = U.parseMailbox(fromInput)
  if (!mb) throw new EmailError(400, 'invalid_from', '"from" must be an email address like notifications@company.com or "Company <notifications@company.com>".')
  const domainName = U.domainOf(mb.address)
  const identity = await db.identities.findOne({ address: mb.address, userId: uid(user) })

  if (domainName === U.config.sharedDomain()) {
    if (!identity) throw new EmailError(403, 'sender_not_allowed', `${mb.address} is not one of your KebSEND addresses. Create it under Sender domains.`)
    return { address: mb.address, name: mb.name || identity.displayName || '', replyTo: identity.replyTo, senderType: 'shared', domainId: null }
  }
  const domain = await db.domains.findOne({ name: domainName, userId: uid(user) })
  if (!domain) throw new EmailError(403, 'domain_not_connected', `${domainName} is not connected to your account. Add it under Sender domains.`)
  if (domain.status !== 'verified') throw new EmailError(403, 'domain_not_verified', `${domainName} is not verified yet. Add the DNS records shown under Sender domains, then check again.`)
  return { address: mb.address, name: mb.name || identity?.displayName || '', replyTo: identity?.replyTo || null, senderType: 'domain', domainId: domain._id }
}

// --------------------------------------------------------------------------
// TEMPLATES
// --------------------------------------------------------------------------

function cleanTemplate(input) {
  const name = String(input.name || '').trim()
  const subject = String(input.subject || '').trim()
  const html = String(input.html || '')
  const text = String(input.text || '')
  if (!name || name.length > 80) throw new EmailError(400, 'invalid_name', 'Give the template a name (up to 80 characters).')
  if (!subject || subject.length > 300 || /[\r\n]/.test(subject)) throw new EmailError(400, 'invalid_subject', 'Add a subject line (one line, up to 300 characters).')
  if (!html.trim() && !text.trim()) throw new EmailError(400, 'empty_body', 'Add an HTML or plain-text body.')
  if (Buffer.byteLength(html) > U.config.maxHtmlBytes) throw new EmailError(413, 'too_large', 'The HTML body is larger than 256 KB.')
  return { name, subject, html, text, variables: U.templateVariables(subject, html, text) }
}
async function listTemplates(user) { return db.templates.find({ userId: uid(user) }, { sort: { updatedAt: -1 } }) }
async function getTemplate(user, id) {
  const t = await db.templates.findOne({ _id: String(id), userId: uid(user) })
  if (!t) throw new EmailError(404, 'template_not_found', 'Template not found.')
  return t
}
async function createTemplate(user, input) { return db.templates.insert({ userId: uid(user), ...cleanTemplate(input) }) }
async function updateTemplate(user, id, input) {
  await getTemplate(user, id)
  return db.templates.updateOne({ _id: String(id), userId: uid(user) }, { $set: cleanTemplate(input) })
}
async function deleteTemplate(user, id) {
  if (!(await db.templates.deleteOne({ _id: String(id), userId: uid(user) }))) throw new EmailError(404, 'template_not_found', 'Template not found.')
  return true
}

// --------------------------------------------------------------------------
// SENDING
// --------------------------------------------------------------------------

function publicMessage(m, { full = false } = {}) {
  if (!m) return m
  const out = {
    id: m._id,
    status: m.status,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    source: m.source,
    credits_charged: m.creditsCharged,
    refunded: !!m.refunded,
    provider: m.provider,
    provider_message_id: m.providerMessageId || null,
    suppressed_recipients: m.suppressedRecipients || [],
    opens: m.opens || 0,
    clicks: m.clicks || 0,
    last_error: m.lastError || null,
    created_at: m.createdAt,
    updated_at: m.updatedAt
  }
  if (full) {
    out.reply_to = m.replyTo
    out.html = m.html
    out.text = m.text
    out.template_id = m.templateId
    out.tags = m.tags
    out.history = m.history
  }
  return out
}

async function sendEmail(user, input, { source = 'api', apiKeyId = null, idempotencyKey = null } = {}) {
  const userId = uid(user)
  provider() // fail early if not configured

  if (idempotencyKey) {
    idempotencyKey = String(idempotencyKey).slice(0, 200)
    const prior = await db.messages.findOne({ userId, idempotencyKey })
    if (prior) return { message: prior, duplicate: true }
  }

  const account = await getAccount(userId)
  if (account.paused) {
    throw new EmailError(403, 'account_paused', `Email sending is paused on this account: ${account.pausedReason}. Contact KebSEND support to review it.`)
  }

  // Template, if any. Explicit fields override the template.
  let subject = input.subject
  let html = input.html
  let text = input.text
  const templateId = input.template_id || input.templateId || null
  const vars = input.variables && typeof input.variables === 'object' ? input.variables : {}
  if (templateId) {
    const t = await getTemplate(user, templateId)
    subject = subject || t.subject
    html = html || t.html
    text = text || t.text
  }
  subject = U.renderTemplate(subject, vars)
  html = U.renderTemplate(html, vars, { html: true })
  text = U.renderTemplate(text, vars)

  subject = typeof subject === 'string' ? subject.trim() : ''
  if (!subject) throw new EmailError(400, 'missing_subject', '"subject" is required.')
  if (subject.length > 998 || /[\r\n]/.test(subject)) throw new EmailError(400, 'invalid_subject', '"subject" must be a single line under 998 characters.')
  if ((typeof html !== 'string' || !html.trim()) && (typeof text !== 'string' || !text.trim())) {
    throw new EmailError(400, 'missing_body', 'Provide "html", "text", or a "template_id".')
  }
  if (html && Buffer.byteLength(html) > U.config.maxHtmlBytes) throw new EmailError(413, 'too_large', '"html" is larger than 256 KB.')
  if (html && !text) text = U.htmlToText(html)

  const sender = await resolveSender(user, input.from)

  const to = U.parseAddressList(input.to)
  const cc = U.parseAddressList(input.cc)
  const bcc = U.parseAddressList(input.bcc)
  const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid]
  if (invalid.length) throw new EmailError(400, 'invalid_recipients', `These addresses are not valid: ${invalid.slice(0, 5).join(', ')}`, { invalid })
  if (!to.list.length) throw new EmailError(400, 'missing_to', '"to" needs at least one email address.')
  const total = to.list.length + cc.list.length + bcc.list.length
  if (total > U.config.maxRecipients()) throw new EmailError(400, 'too_many_recipients', `Up to ${U.config.maxRecipients()} recipients per email (to + cc + bcc). Bulk email is coming separately.`)

  let replyTo = sender.replyTo
  if (input.reply_to || input.replyTo) {
    const r = U.parseMailbox(input.reply_to || input.replyTo)
    if (!r) throw new EmailError(400, 'invalid_reply_to', '"reply_to" must be a valid email address.')
    replyTo = r.address
  }

  let tags = []
  if (Array.isArray(input.tags)) {
    tags = input.tags.slice(0, 10).map(t => ({ name: String(t?.name || ''), value: String(t?.value || '') }))
    if (tags.some(t => !/^[A-Za-z0-9_-]{1,256}$/.test(t.name) || !/^[A-Za-z0-9_-]{1,256}$/.test(t.value))) {
      throw new EmailError(400, 'invalid_tags', 'Tag names and values may only use letters, numbers, _ and -.')
    }
  }

  // Suppressed addresses (earlier hard bounces, complaints, unsubscribes) are skipped and not charged.
  const everyone = [...to.list, ...cc.list, ...bcc.list]
  const suppressed = new Set((await db.suppressions.find({ userId, address: { $in: everyone } })).map(s => s.address))
  const keep = l => l.filter(a => !suppressed.has(a))
  const finalTo = keep(to.list)
  const finalCc = keep(cc.list)
  const finalBcc = keep(bcc.list)
  if (!finalTo.length) {
    throw new EmailError(422, 'all_suppressed', 'Every "to" address is on your suppression list (bounced, complained or unsubscribed) so nothing was sent.', { suppressed: [...suppressed] })
  }

  // Daily cap for accounts that have never paid.
  const cap = U.config.dailyCapUnpaid()
  if (cap > 0) {
    const txs = await TransactionRepo.listByUser(userId, 50)
    const hasPaid = txs.some(t => t.status === 'success')
    if (!hasPaid) {
      const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0)
      const today = await db.messages.count({ userId, createdAt: { $gte: startOfDay.toISOString() } })
      if (today >= cap) throw new EmailError(429, 'daily_cap', `New accounts can send ${cap} emails a day until their first top-up.`)
    }
  }

  const recipients = finalTo.length + finalCc.length + finalBcc.length
  const cost = U.round2(recipients * U.config.creditsPerRecipient())
  const debit = await UserRepo.debitBalance(userId, cost)
  if (!debit.ok) {
    throw new EmailError(402, 'insufficient_balance', `Not enough credits. This email needs ${cost} credits and your balance is ${U.round2(debit.balance || 0)}.`, { required: cost, balance: debit.balance })
  }

  const now = nowIso()
  let message
  try {
    message = await db.messages.insert({
      userId,
      apiKeyId,
      source,
      from: U.formatMailbox({ name: sender.name, address: sender.address }),
      fromAddress: sender.address,
      senderType: sender.senderType,
      domainId: sender.domainId,
      to: finalTo,
      cc: finalCc,
      bcc: finalBcc,
      replyTo,
      subject,
      html: html || null,
      text: text || null,
      templateId,
      tags,
      suppressedRecipients: [...suppressed],
      status: 'queued',
      history: [{ status: 'queued', at: now }],
      provider: getProvider().name,
      providerMessageId: null,
      creditsCharged: cost,
      refunded: false,
      attempts: 0,
      nextAttemptAt: now,
      lockedUntil: EPOCH,
      lastError: null,
      idempotencyKey: idempotencyKey || null,
      opens: 0,
      clicks: 0
    })
  } catch (err) {
    await UserRepo.creditBalance(userId, cost)
    if (idempotencyKey && /duplicate key/i.test(err.message)) {
      return { message: await db.messages.findOne({ userId, idempotencyKey }), duplicate: true }
    }
    throw err
  }
  kick()
  return { message, balance: debit.balance }
}

async function refund(message, reason) {
  const claimed = await db.messages.updateOne(
    { _id: message._id, refunded: false, creditsCharged: { $gt: 0 } },
    { $set: { refunded: true, refundedAt: nowIso(), refundReason: reason } }
  )
  if (claimed) await UserRepo.creditBalance(claimed.userId, claimed.creditsCharged)
  return !!claimed
}

// Move a message to a new status if it is a step forward; always keep the history line.
async function transition(message, status, detail) {
  const entry = { status, at: nowIso(), ...(detail ? { detail } : {}) }
  for (let i = 0; i < 3; i++) {
    const current = i === 0 ? message : await db.messages.findOne({ _id: message._id })
    const advance = STATUS_RANK[status] > STATUS_RANK[current.status]
    const update = { $push: { history: entry } }
    if (advance) update.$set = { status }
    const updated = await db.messages.updateOne({ _id: current._id, status: current.status }, update)
    if (updated) return { message: updated, advanced: advance }
  }
  return { message, advanced: false }
}

// --------------------------------------------------------------------------
// OUTBOX WORKER
// --------------------------------------------------------------------------

let working = false
let again = false

async function deliverOne(m) {
  const p = getProvider()
  try {
    const { providerMessageId } = await p.send({
      id: m._id, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc, replyTo: m.replyTo,
      subject: m.subject, html: m.html, text: m.text, tags: m.tags
    })
    const updated = await db.messages.updateOne({ _id: m._id }, {
      $set: { providerMessageId, provider: p.name, attempts: m.attempts + 1, lastError: null, acceptedAt: nowIso() }
    })
    await transition(updated, 'accepted')
    await replayEarlyEvents(updated._id, providerMessageId)
  } catch (err) {
    const attempts = m.attempts + 1
    if (err.retryable && attempts < MAX_ATTEMPTS) {
      const wait = 5000 * Math.pow(3, attempts - 1) // 5s, 15s
      await db.messages.updateOne({ _id: m._id }, {
        $set: { attempts, lastError: err.message, nextAttemptAt: new Date(Date.now() + wait).toISOString(), lockedUntil: EPOCH }
      })
      return
    }
    const finalStatus = err.retryable ? 'failed' : 'rejected'
    const updated = await db.messages.updateOne({ _id: m._id }, { $set: { attempts, lastError: err.message } })
    await transition(updated, finalStatus, err.message)
    await refund(updated, finalStatus + ': ' + err.message)
  }
}

async function processQueue() {
  if (working) { again = true; return }
  working = true
  try {
    do {
      again = false
      for (let n = 0; n < 50; n++) {
        const now = nowIso()
        const m = await db.messages.updateOne(
          { status: 'queued', nextAttemptAt: { $lte: now }, lockedUntil: { $lte: now } },
          { $set: { lockedUntil: new Date(Date.now() + 60000).toISOString() } }
        )
        if (!m) break
        await deliverOne(m)
      }
    } while (again)
  } catch (err) {
    console.error('[Email worker]', err)
  } finally {
    working = false
  }
}

function kick() {
  setImmediate(() => processQueue())
}

// Remove stored bodies after the retention period; metadata stays for reporting.
async function purgeOldContent() {
  const cutoff = new Date(Date.now() - U.config.retentionDays() * 24 * 3600 * 1000).toISOString()
  const old = await db.messages.find({ createdAt: { $lt: cutoff }, contentPurged: { $ne: true } }, { limit: 200 })
  for (const m of old) await db.messages.updateOne({ _id: m._id }, { $set: { html: null, text: null, contentPurged: true } })
}

let timers = []
function startWorker() {
  if (timers.length) return
  const every = (ms, fn) => { const t = setInterval(() => fn().catch(e => console.warn('[Email worker]', e.message)), ms); if (t.unref) t.unref(); timers.push(t) }
  every(5000, processQueue)
  every(60 * 1000, recheckPendingDomains)
  every(60 * 60 * 1000, purgeOldContent)
  ensureIndexes().catch(() => {})
  try {
    const p = getProvider()
    if (p.setEventSink) p.setEventSink(evt => applyEvent(evt, p.name))
  } catch (e) {
    console.warn('[Email] Provider not ready:', e.message)
  }
  kick()
}
function stopWorker() { timers.forEach(clearInterval); timers = [] }

// --------------------------------------------------------------------------
// PROVIDER EVENTS (webhooks)
// --------------------------------------------------------------------------

async function suppress(userId, addresses, reason, sourceMessageId) {
  for (const address of addresses) {
    if (await db.suppressions.findOne({ userId, address })) continue
    try { await db.suppressions.insert({ userId, address, reason, sourceMessageId }) } catch (e) { /* duplicate */ }
  }
}

async function applyEvent(evt, providerName) {
  if (!evt || !evt.type || !evt.providerEventId) return { ignored: true }
  if (await db.events.findOne({ provider: providerName, providerEventId: evt.providerEventId })) return { duplicate: true }
  let eventRow
  try {
    eventRow = await db.events.insert({
      provider: providerName,
      providerEventId: evt.providerEventId,
      type: evt.type,
      providerType: evt.providerType,
      providerMessageId: evt.providerMessageId || null,
      messageId: null,
      occurredAt: evt.occurredAt,
      detail: evt.detail || null,
      bounceType: evt.bounceType || null,
      recipients: evt.recipients || [],
      raw: evt.raw
    })
  } catch (err) {
    if (/duplicate key/i.test(err.message)) return { duplicate: true }
    throw err
  }

  let message = evt.providerMessageId ? await db.messages.findOne({ providerMessageId: evt.providerMessageId }) : null
  if (!message) {
    const tagId = evt.raw?.data?.tags?.kebsend_message_id
    if (tagId) message = await db.messages.findOne({ _id: String(tagId) })
  }
  if (!message) return { unmatched: true } // kept; replayed once the send is recorded
  return applyEventToMessage(eventRow, evt, message)
}

// Work out which recipients bounced. With several recipients we only suppress
// addresses we can pin down, so one bad address never blocks the others.
function bouncedAddresses(evt, message) {
  const all = [...(message.to || []), ...(message.cc || []), ...(message.bcc || [])]
  const reported = (evt.recipients || []).map(a => String(a).toLowerCase()).filter(a => all.includes(a))
  const candidates = reported.length ? reported : all
  if (candidates.length === 1) return candidates
  const detail = String(evt.detail || '').toLowerCase()
  return candidates.filter(a => detail.includes(a))
}

async function applyEventToMessage(eventRow, evt, message) {
  await db.events.updateOne({ _id: eventRow._id }, { $set: { messageId: message._id, appliedAt: nowIso() } })

  if (evt.type === 'opened') {
    await db.messages.updateOne({ _id: message._id }, { $inc: { opens: 1 }, $set: { lastOpenedAt: evt.occurredAt } })
    return { applied: 'opened' }
  }
  if (evt.type === 'clicked') {
    await db.messages.updateOne({ _id: message._id }, { $inc: { clicks: 1 }, $set: { lastClickedAt: evt.occurredAt } })
    return { applied: 'clicked' }
  }
  const status = EVENT_TO_STATUS[evt.type]
  if (!status) return { ignored: true }

  const { message: updated } = await transition(message, status, evt.detail)
  if (status === 'bounced' && (!evt.bounceType || /permanent|hard/i.test(evt.bounceType))) {
    await suppress(message.userId, bouncedAddresses(evt, message), 'bounce', message._id)
  }
  if (status === 'complained') await suppress(message.userId, message.to, 'complaint', message._id)
  if (REFUNDABLE.has(status)) await refund(updated, 'provider ' + evt.type)
  if (status === 'bounced' || status === 'complained') await checkHealth(message.userId)
  return { applied: status }
}

// A webhook can beat our own write of the provider id; apply anything that arrived early.
async function replayEarlyEvents(messageId, providerMessageId) {
  const early = await db.events.find({ providerMessageId, messageId: null }, { sort: { createdAt: 1 } })
  for (const e of early) {
    const message = await db.messages.findOne({ _id: messageId })
    await applyEventToMessage(e, e, message)
  }
}

async function handleWebhook(rawBody, headers) {
  const p = getProvider()
  if (p.name === 'mock' && process.env.NODE_ENV === 'production') throw new EmailError(404, 'not_found', 'Not found')
  let evt
  try {
    evt = p.parseWebhook(rawBody, headers)
  } catch (err) {
    throw new EmailError(401, 'invalid_signature', 'Invalid webhook signature')
  }
  return applyEvent(evt, p.name)
}

// --------------------------------------------------------------------------
// REPORTING
// --------------------------------------------------------------------------

async function listMessages(user, { status, q, limit = 50, skip = 0, apiKeyId } = {}) {
  const filter = { userId: uid(user) }
  if (status && STATUS_RANK[status] !== undefined) filter.status = status
  if (apiKeyId) filter.apiKeyId = apiKeyId
  let list = await db.messages.find(filter, { limit: q ? 500 : Math.min(Number(limit) || 50, 200), skip: q ? 0 : Number(skip) || 0 })
  if (q) {
    const needle = String(q).toLowerCase()
    list = list.filter(m => [m.subject, m.fromAddress, ...(m.to || [])].some(v => String(v || '').toLowerCase().includes(needle))).slice(0, 100)
  }
  return list
}

async function getMessage(user, id) {
  const m = await db.messages.findOne({ _id: String(id), userId: uid(user) })
  if (!m) throw new EmailError(404, 'not_found', 'Email not found.')
  return m
}

async function stats(user) {
  const userId = uid(user)
  const statuses = Object.keys(STATUS_RANK)
  const counts = {}
  await Promise.all(statuses.map(async s => { counts[s] = await db.messages.count({ userId, status: s }) }))
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const delivered = counts.delivered + counts.complained
  const bounced = counts.bounced
  const failed = counts.failed + counts.rejected
  const inFlight = counts.queued + counts.accepted + counts.sent + counts.delayed
  const settled = delivered + bounced + failed
  const since = new Date(Date.now() - 13 * 24 * 3600 * 1000); since.setUTCHours(0, 0, 0, 0)
  const recent = await db.messages.find({ userId, createdAt: { $gte: since.toISOString() } }, { limit: 5000 })
  const days = []
  for (let i = 0; i < 14; i++) {
    const d = new Date(since.getTime() + i * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const day = recent.filter(m => String(m.createdAt).slice(0, 10) === d)
    days.push({ date: d, sent: day.length, delivered: day.filter(m => m.status === 'delivered' || m.status === 'complained').length, problems: day.filter(m => ['bounced', 'failed', 'rejected'].includes(m.status)).length })
  }
  return {
    counts,
    total,
    delivered,
    bounced,
    failed,
    complained: counts.complained,
    inFlight,
    deliveryRate: settled ? U.round2((delivered / settled) * 100) : null,
    creditsSpent: U.round2(recent.reduce((a, m) => a + (m.refunded ? 0 : m.creditsCharged || 0), 0)),
    days
  }
}

async function listSuppressions(user) { return db.suppressions.find({ userId: uid(user) }) }
async function removeSuppression(user, id) {
  if (!(await db.suppressions.deleteOne({ _id: String(id), userId: uid(user) }))) throw new EmailError(404, 'not_found', 'Not found.')
  return true
}

async function apiKeyUsage(user, keyIds) {
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
  const out = {}
  for (const id of keyIds) {
    const [month, last] = await Promise.all([
      db.messages.count({ userId: uid(user), apiKeyId: String(id), createdAt: { $gte: monthStart.toISOString() } }),
      db.messages.find({ userId: uid(user), apiKeyId: String(id) }, { limit: 1 })
    ])
    out[id] = { sentThisMonth: month, lastUsedAt: last[0]?.createdAt || null }
  }
  return out
}

module.exports = {
  EmailError,
  STATUS_RANK,
  publicMessage,
  // domains + senders
  listDomains, addDomain, refreshDomain, removeDomain, getOwnedDomain,
  listIdentities, createIdentity, removeIdentity, listSenders,
  // templates
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  // sending + events
  sendEmail, applyEvent, handleWebhook, processQueue, startWorker, stopWorker,
  // reporting
  listMessages, getMessage, stats, listSuppressions, removeSuppression, getAccount, apiKeyUsage
}
