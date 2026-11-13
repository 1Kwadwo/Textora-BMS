// HTTP routes for KebSEND Email. Thin: parse, authenticate, call the engine.
//   /api/email/*        dashboard (JWT login)
//   /api/v1/email/*     public API (API key with the "email" scope)
//   /webhooks/resend    provider events (signature checked)
const engine = require('./engine')
const { EmailError, publicMessage } = engine
const { ApiKeyRepo, keyHasScope } = require('../models')
const U = require('./util')
const { isEmailEnabled } = require('./providers')
const wallet = require('./wallet')
const pricing = require('./pricing')
const { initializePayment, verifyPayment } = require('../services/paystack')

function baseUrlOf(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  const proto = String(req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http')).split(',')[0].trim()
  return `${proto}://${req.headers.host || 'localhost:4000'}`
}

function unsubscribePage(ok, address) {
  const title = ok ? 'You are unsubscribed' : 'This link is not valid'
  const body = ok
    ? `<b>${U.escapeHtml(address)}</b> will not get marketing email from this sender again. Receipts and security codes you ask for can still arrive.`
    : 'The unsubscribe link is incomplete or has been changed. Use the link from the bottom of the email.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · KebSEND</title><link rel="stylesheet" href="/style.css?v=18"></head>
<body class="min-h-screen bg-cream-50 font-sans text-navy-900 antialiased"><main class="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
<img src="/kebsend-logo.png" alt="KebSEND" class="mb-8 h-8 w-auto self-start">
<div class="dash-surface-card p-6"><h1 class="text-2xl font-black tracking-tight">${title}</h1><p class="mt-3 text-sm leading-relaxed text-ink">${body}</p></div>
<p class="mt-6 text-xs text-ink">Sent through KebSEND Email.</p></main></body></html>`
}

const buckets = new Map()
function limited(key, max, windowMs) {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + windowMs }); return false }
  b.n++
  return b.n > max
}
const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k) }, 60000)
if (sweep.unref) sweep.unref()

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > 1024 * 1024) { reject(new EmailError(413, 'too_large', 'Request body is too large.')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function domainView(d) {
  return {
    id: d._id,
    name: d.name,
    status: d.status,
    provider: d.provider,
    region: d.region,
    records: (d.records || []).map(r => ({ ...r, host: r.name === '@' ? d.name : `${r.name}.${d.name}` })),
    created_at: d.createdAt,
    last_checked_at: d.lastCheckedAt,
    verified_at: d.verifiedAt
  }
}

function isEmailRoute(urlPath) {
  return urlPath.startsWith('/api/email/') || urlPath.startsWith('/api/v1/email/') || urlPath === '/webhooks/resend' || urlPath === '/webhooks/email' || urlPath === '/email/unsubscribe'
}

// Returns true when the request was an email route (and has been answered).
async function handleEmailRoutes(req, res, ctx) {
  if (!isEmailRoute(ctx.urlPath)) return false
  await route(req, res, ctx)
  return true
}

async function route(req, res, ctx) {
  const { urlPath, urlObj, json, authenticateUser, authenticateApiKey } = ctx
  const isApi = urlPath.startsWith('/api/v1/email/')
  const isHook = urlPath === '/webhooks/resend' || urlPath === '/webhooks/email'

  const fail = err => {
    if (err instanceof EmailError) return json(err.status, { ok: false, error: { code: err.code, message: err.message, ...err.extra }, message: err.message })
    console.error('[Email route error]', urlPath, err)
    return json(500, { ok: false, error: { code: 'server_error', message: 'Something went wrong. Please try again.' }, message: 'Something went wrong. Please try again.' })
  }
  const body = async () => {
    const raw = await readRaw(req)
    if (!raw.length) return {}
    try { return JSON.parse(raw.toString('utf8')) } catch (e) { throw new EmailError(400, 'invalid_json', 'Request body must be valid JSON.') }
  }

  try {
    // ------------------------------------------------------------------ unsubscribe (public link in marketing email)
    if (urlPath === '/email/unsubscribe') {
      if (req.method !== 'GET' && req.method !== 'POST') return json(405, { ok: false, message: 'Method not allowed' })
      if (limited('unsub:' + (req.socket?.remoteAddress || ''), 60, 60000)) return json(429, { ok: false, message: 'Too many requests' })
      let ok = true
      let who = null
      try { who = await engine.unsubscribe(urlObj.searchParams) } catch (e) { ok = false }
      if (req.method === 'POST') return json(ok ? 200 : 400, { ok })
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(unsubscribePage(ok, who?.address))
    }

    // ------------------------------------------------------------------ webhook
    if (isHook) {
      if (req.method !== 'POST') return json(405, { ok: false, message: 'Method not allowed' })
      const raw = await readRaw(req)
      const result = await engine.handleWebhook(raw, req.headers)
      return json(200, { ok: true, ...result })
    }

    // ------------------------------------------------------------------ public API
    if (isApi) {
      const auth = await authenticateApiKey()
      if (!auth) return json(401, { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid API key.' }, message: 'Missing or invalid API key. Use Authorization: Bearer ksnd_live_...' })
      if (auth.isBotDev) throw new EmailError(403, 'wrong_key_type', 'Email API keys are created on the KebSEND website under Email > API keys.')
      if (!keyHasScope(auth.apiKeyDoc, 'email')) throw new EmailError(403, 'missing_scope', 'This API key is for SMS. Create an email API key under Email > API keys.')
      const user = auth.user
      const keyId = String(auth.apiKeyDoc._id || auth.apiKeyDoc.id || '')
      if (limited('email-api:' + keyId, U.config.apiRatePerMinute(), 60000)) {
        throw new EmailError(429, 'rate_limited', `Rate limit is ${U.config.apiRatePerMinute()} requests a minute per key.`)
      }

      if (urlPath === '/api/v1/email/balance' && req.method === 'GET') {
        const b = await wallet.balances(user._id || user.id)
        return json(200, { ok: true, credits: b })
      }

      if (urlPath === '/api/v1/email/send' && req.method === 'POST') {
        const input = await body()
        const { message, campaign, duplicate, balance } = await engine.sendEmail(user, input, {
          source: 'api', apiKeyId: keyId, idempotencyKey: req.headers['idempotency-key'] || null, baseUrl: baseUrlOf(req)
        })
        if (campaign) {
          return json(duplicate ? 200 : 202, {
            ok: true,
            type: 'marketing',
            campaign_id: campaign._id,
            recipients: campaign.recipients,
            credits_charged: campaign.creditsCharged,
            remaining_credits: balance ?? undefined,
            suppressed_recipients: campaign.suppressedRecipients,
            duplicate: !!duplicate
          })
        }
        return json(duplicate ? 200 : 202, {
          ok: true,
          type: 'transactional',
          id: message._id,
          status: message.status,
          credits_charged: message.creditsCharged,
          remaining_credits: balance ?? undefined,
          suppressed_recipients: message.suppressedRecipients,
          duplicate: !!duplicate
        })
      }
      const msgMatch = urlPath.match(/^\/api\/v1\/email\/messages\/([A-Za-z0-9_]+)$/)
      if (msgMatch && req.method === 'GET') {
        return json(200, { ok: true, message: publicMessage(await engine.getMessage(user, msgMatch[1])) })
      }
      if (urlPath === '/api/v1/email/messages' && req.method === 'GET') {
        const list = await engine.listMessages(user, { status: urlObj.searchParams.get('status'), type: urlObj.searchParams.get('type'), limit: urlObj.searchParams.get('limit') })
        return json(200, { ok: true, messages: list.map(m => publicMessage(m)) })
      }
      if (urlPath === '/api/v1/email/domains' && req.method === 'GET') {
        return json(200, { ok: true, domains: (await engine.listDomains(user)).map(d => ({ name: d.name, status: d.status })) })
      }
      if (urlPath === '/api/v1/email/senders' && req.method === 'GET') {
        return json(200, { ok: true, senders: (await engine.listSenders(user)).map(s => ({ from: s.from, ready: s.ready })) })
      }
      return json(404, { ok: false, message: 'Not Found' })
    }

    // ------------------------------------------------------------------ dashboard
    const user = await authenticateUser()
    if (!user) return json(401, { ok: false, message: 'Unauthorized' })
    const userId = String(user._id || user.id)
    const m = re => urlPath.match(re)

    if (urlPath === '/api/email/overview' && req.method === 'GET') {
      const [stats, recent, account, senders, domains] = await Promise.all([
        engine.stats(user), engine.listMessages(user, { limit: 8 }), engine.getAccount(userId), engine.listSenders(user), engine.listDomains(user)
      ])
      return json(200, {
        ok: true,
        user: { id: userId, name: user.name, email: user.email },
        credits: { transactional: Number(account.txCredits || 0), marketing: Number(account.mkCredits || 0) },
        settings: { enabled: isEmailEnabled(), sharedDomain: U.config.sharedDomain(), maxRecipients: U.config.maxRecipients(), maxCampaignRecipients: U.config.maxCampaignRecipients() },
        account: { paused: !!account.paused, pausedReason: account.pausedReason || null },
        stats,
        recent: recent.map(x => publicMessage(x)),
        senders: senders.length,
        domains: { total: domains.length, verified: domains.filter(d => d.status === 'verified').length }
      })
    }

    if (urlPath === '/api/email/send' && req.method === 'POST') {
      if (limited('email-dash:' + userId, 30, 60000)) throw new EmailError(429, 'rate_limited', 'Sending too fast. Please wait a moment.')
      const { message, campaign, balance } = await engine.sendEmail(user, await body(), { source: 'dashboard', baseUrl: baseUrlOf(req) })
      if (campaign) return json(202, { ok: true, type: 'marketing', campaign: { id: campaign._id, recipients: campaign.recipients, credits_charged: campaign.creditsCharged, suppressed_recipients: campaign.suppressedRecipients }, remaining_credits: balance })
      return json(202, { ok: true, type: 'transactional', message: publicMessage(message), remaining_credits: balance })
    }

    // Email credits (separate from SMS credits)
    if (urlPath === '/api/email/credits' && req.method === 'GET') {
      const [balances, history] = await Promise.all([wallet.balances(userId), wallet.purchaseHistory(userId)])
      return json(200, { ok: true, credits: balances, pricing: pricing.pricing(), history })
    }
    if (urlPath === '/api/email/credits/checkout' && req.method === 'POST') {
      if (limited('email-buy:' + userId, 10, 60000)) throw new EmailError(429, 'rate_limited', 'Too many checkout attempts. Please wait a minute.')
      const b = await body()
      const type = String(b.type || '')
      if (!pricing.isProduct(type)) throw new EmailError(400, 'invalid_type', 'Choose transactional or marketing credits.')
      const made = await wallet.createPurchase(user, type, b.packId)
      if (!made) throw new EmailError(400, 'invalid_pack', 'That credit pack is not available.')
      const callbackUrl = `${baseUrlOf(req)}/email#credits?ref=${made.reference}`
      let payment
      try {
        payment = await initializePayment({ email: user.email, amountGHS: made.pack.priceGHS, reference: made.reference, callbackUrl })
      } catch (e) {
        console.error('[Email credits] Paystack init failed', e.message)
      }
      const checkoutUrl = payment?.data?.authorization_url
      if (!checkoutUrl) throw new EmailError(502, 'checkout_failed', 'Could not open Paystack checkout. Please try again.')
      return json(200, { ok: true, reference: made.reference, type, pack: made.pack, checkout_url: checkoutUrl })
    }
    if (urlPath === '/api/email/credits/verify' && req.method === 'GET') {
      const reference = String(urlObj.searchParams.get('reference') || '')
      const r = await wallet.fulfillPurchase(reference, {
        userId,
        confirm: async () => {
          const v = await verifyPayment(reference)
          return !!(v && v.status && v.data?.status === 'success')
        }
      })
      if (!r.ok && r.reason === 'not_paid') return json(200, { ok: false, pending: true, message: 'Waiting for payment confirmation.' })
      if (!r.ok) throw new EmailError(404, 'not_found', 'Payment not found.')
      return json(200, { ok: true, type: r.product, emails: r.emails, already: !!r.already, credits: await wallet.balances(userId) })
    }

    if (urlPath === '/api/email/messages' && req.method === 'GET') {
      const sp = urlObj.searchParams
      const list = await engine.listMessages(user, { status: sp.get('status'), type: sp.get('type'), q: sp.get('q'), limit: sp.get('limit') || 100, skip: sp.get('skip') })
      return json(200, { ok: true, messages: list.map(x => publicMessage(x)) })
    }
    let hit
    if ((hit = m(/^\/api\/email\/messages\/([A-Za-z0-9_]+)$/)) && req.method === 'GET') {
      const msg = await engine.getMessage(user, hit[1])
      const out = publicMessage(msg, { full: true })
      if (msg.campaignId) Object.assign(out, await engine.messageContent(msg))
      return json(200, { ok: true, message: out })
    }

    // Sender domains
    if (urlPath === '/api/email/domains' && req.method === 'GET') {
      return json(200, { ok: true, sharedDomain: U.config.sharedDomain(), domains: (await engine.listDomains(user)).map(domainView) })
    }
    if (urlPath === '/api/email/domains' && req.method === 'POST') {
      const { name } = await body()
      return json(201, { ok: true, domain: domainView(await engine.addDomain(user, name)) })
    }
    if ((hit = m(/^\/api\/email\/domains\/([A-Za-z0-9_]+)\/verify$/)) && req.method === 'POST') {
      if (limited('email-verify:' + userId, 20, 60000)) throw new EmailError(429, 'rate_limited', 'Checking too often. Try again in a minute.')
      return json(200, { ok: true, domain: domainView(await engine.refreshDomain(user, hit[1])) })
    }
    if ((hit = m(/^\/api\/email\/domains\/([A-Za-z0-9_]+)$/)) && req.method === 'DELETE') {
      await engine.removeDomain(user, hit[1])
      return json(200, { ok: true })
    }

    // Sender identities
    if (urlPath === '/api/email/senders' && req.method === 'GET') {
      return json(200, { ok: true, sharedDomain: U.config.sharedDomain(), senders: await engine.listSenders(user) })
    }
    if (urlPath === '/api/email/senders' && req.method === 'POST') {
      const b = await body()
      return json(201, { ok: true, sender: await engine.createIdentity(user, { address: b.address, handle: b.handle, displayName: b.displayName, replyTo: b.replyTo }) })
    }
    if ((hit = m(/^\/api\/email\/senders\/([A-Za-z0-9_]+)$/)) && req.method === 'DELETE') {
      await engine.removeIdentity(user, hit[1])
      return json(200, { ok: true })
    }

    // Templates
    if (urlPath === '/api/email/templates' && req.method === 'GET') {
      return json(200, { ok: true, templates: await engine.listTemplates(user) })
    }
    if (urlPath === '/api/email/templates' && req.method === 'POST') {
      return json(201, { ok: true, template: await engine.createTemplate(user, await body()) })
    }
    if ((hit = m(/^\/api\/email\/templates\/([A-Za-z0-9_]+)$/))) {
      if (req.method === 'GET') return json(200, { ok: true, template: await engine.getTemplate(user, hit[1]) })
      if (req.method === 'PUT') return json(200, { ok: true, template: await engine.updateTemplate(user, hit[1], await body()) })
      if (req.method === 'DELETE') { await engine.deleteTemplate(user, hit[1]); return json(200, { ok: true }) }
    }

    // Suppressions
    if (urlPath === '/api/email/suppressions' && req.method === 'GET') {
      return json(200, { ok: true, suppressions: await engine.listSuppressions(user) })
    }
    if ((hit = m(/^\/api\/email\/suppressions\/([A-Za-z0-9_]+)$/)) && req.method === 'DELETE') {
      await engine.removeSuppression(user, hit[1])
      return json(200, { ok: true })
    }

    // Email API keys (same key store as SMS, scoped to email)
    if (urlPath === '/api/email/api-keys' && req.method === 'GET') {
      const keys = await ApiKeyRepo.listByUser(userId, 'email')
      const usage = await engine.apiKeyUsage(user, keys.map(k => String(k._id || k.id)))
      return json(200, {
        ok: true,
        keys: keys.map(k => ({ id: String(k._id || k.id), name: k.name, key: k.key, createdAt: k.createdAt, ...usage[String(k._id || k.id)] }))
      })
    }
    if (urlPath === '/api/email/api-keys' && req.method === 'POST') {
      const b = await body()
      const name = String(b.name || '').trim().slice(0, 60) || 'Email key ' + new Date().toISOString().slice(0, 10)
      const k = await ApiKeyRepo.generate(userId, name, ['email'])
      return json(201, { ok: true, apiKey: { id: String(k._id || k.id), name: k.name, key: k.key, createdAt: k.createdAt } })
    }
    if ((hit = m(/^\/api\/email\/api-keys\/([A-Za-z0-9_]+)$/)) && req.method === 'DELETE') {
      const keys = await ApiKeyRepo.listByUser(userId, 'email')
      if (!keys.some(k => String(k._id || k.id) === hit[1])) throw new EmailError(404, 'not_found', 'Key not found.')
      await ApiKeyRepo.revoke(userId, hit[1])
      return json(200, { ok: true })
    }

    return json(404, { ok: false, message: 'Not Found' })
  } catch (err) {
    return fail(err)
  }
}

module.exports = { handleEmailRoutes }
