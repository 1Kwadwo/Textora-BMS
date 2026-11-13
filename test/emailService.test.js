const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

// Isolated email store; mock provider with instant domain verification.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kebsend-email-'))
process.env.EMAIL_STORE_FILE = path.join(tmpDir, 'email-store.json')
process.env.EMAIL_PROVIDER = 'mock'
process.env.EMAIL_MOCK_VERIFY_AFTER_MS = '1500'
process.env.EMAIL_DAILY_CAP_UNPAID = '0'
process.env.EMAIL_FREE_TRANSACTIONAL = '3'
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef'
delete process.env.MONGODB_URI
process.env.WEB_PORT = '4011'

const { UserRepo } = require('../web/src/models')
const { hashPassword, generateToken } = require('../web/src/auth')
const U = require('../web/src/email/util')
const { createResendProvider } = require('../web/src/email/providers/resend')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const req = http.request(`http://localhost:4011${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
    }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => {
        let json = {}
        try { json = JSON.parse(data) } catch (e) { json = { raw: data } }
        resolve({ status: res.statusCode, data: json })
      })
    })
    req.on('error', reject)
    if (body) req.write(payload)
    req.end()
  })
}

test('util: addresses, mailboxes and templates', () => {
  assert.deepStrictEqual(U.parseMailbox('Ashfoam <Orders@Ashfoam.com.gh>'), { name: 'Ashfoam', address: 'orders@ashfoam.com.gh' })
  assert.strictEqual(U.parseMailbox('bad\r\nBcc: x@y.com'), null)
  assert.strictEqual(U.parseMailbox('not-an-email'), null)
  const list = U.parseAddressList('a@x.com, b@x.com; a@x.com\nnope')
  assert.deepStrictEqual(list.list, ['a@x.com', 'b@x.com'])
  assert.deepStrictEqual(list.invalid, ['nope'])
  assert.strictEqual(U.renderTemplate('<p>{{name}}</p>', { name: '<script>' }, { html: true }), '<p>&lt;script&gt;</p>')
  assert.strictEqual(U.renderTemplate('Hi {{ name }}', { name: 'Kofi' }), 'Hi Kofi')
})

test('resend adapter: webhook signatures are enforced', () => {
  const { Webhook } = require('standardwebhooks')
  const secret = 'whsec_' + Buffer.from('a-very-secret-signing-key-123456').toString('base64')
  const p = createResendProvider({ apiKey: 're_test_dummy', webhookSecret: secret })
  const body = JSON.stringify({ type: 'email.delivered', created_at: new Date().toISOString(), data: { email_id: 'abc-123', to: ['a@b.com'] } })
  const ts = new Date()
  const sig = new Webhook(secret).sign('msg_1', ts, body)
  const headers = { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(ts.getTime() / 1000)), 'svix-signature': sig }
  const evt = p.parseWebhook(Buffer.from(body), headers)
  assert.strictEqual(evt.type, 'delivered')
  assert.strictEqual(evt.providerMessageId, 'abc-123')
  assert.strictEqual(evt.providerEventId, 'msg_1')
  assert.throws(() => p.parseWebhook(Buffer.from(body.replace('delivered', 'bounced')), headers))
})


test('email pricing: two products, each with its own packs', () => {
  const pricing = require('../web/src/email/pricing')
  const p = pricing.pricing()
  assert.ok(p.transactional.packs.length >= 3)
  assert.ok(p.marketing.packs.length >= 3)
  const ids = [...p.transactional.packs, ...p.marketing.packs].map(x => x.id)
  assert.strictEqual(new Set(ids).size, ids.length, 'pack ids are unique')
  assert.strictEqual(pricing.findPack('marketing', 'tx-1k'), null, 'a transactional pack cannot be bought as marketing')
  for (const x of p.transactional.packs) assert.ok(x.perEmailGHS > 0)
})

test('KebSEND Email: domains, sending, credits, events, keys', async t => {
  const server = require('../web/server.js')
  const wallet = require('../web/src/email/wallet')
  const engine = require('../web/src/email/engine')
  await sleep(300)

  const email = `email_${Date.now()}@kebsend.test`
  const user = await UserRepo.create({ name: 'Efua Test', email, phone: '', passwordHash: await hashPassword('x'), initialBalance: 5, isVerified: true })
  const userId = String(user._id || user.id)
  const auth = { Authorization: 'Bearer ' + generateToken(user) }
  const smsBalance = async () => (await UserRepo.findById(userId)).balance
  const tx = async () => (await wallet.balances(userId)).transactional
  const mk = async () => (await wallet.balances(userId)).marketing

  let sharedFrom
  await t.test('new accounts get a small free transactional allowance; email never touches SMS credits', async () => {
    const s = await request('POST', '/api/email/senders', { handle: `efua${Date.now() % 100000}`, displayName: 'Efua Shop' }, auth)
    assert.strictEqual(s.status, 201, JSON.stringify(s.data))
    sharedFrom = s.data.sender.address
    assert.strictEqual(await tx(), 3)
    const res = await request('POST', '/api/email/send', { from: sharedFrom, to: 'kofi@example.com, ama@example.com', subject: 'Hi', text: 'Hello' }, auth)
    assert.strictEqual(res.status, 202, JSON.stringify(res.data))
    assert.strictEqual(res.data.type, 'transactional')
    assert.strictEqual(res.data.message.credits_charged, 2)
    assert.strictEqual(res.data.remaining_credits, 1)
    assert.strictEqual(await tx(), 1)
    assert.strictEqual(await smsBalance(), 5, 'SMS wallet is untouched')
    await sleep(1600)
    const m = await request('GET', '/api/email/messages/' + res.data.message.id, null, auth)
    assert.strictEqual(m.data.message.status, 'delivered')
    assert.ok(m.data.message.provider_message_id.startsWith('mock_'))
  })

  await t.test('SMS credits cannot pay for email', async () => {
    // 1 transactional credit left, plenty of SMS credits: a 2-recipient email is refused.
    await UserRepo.creditBalance(userId, 1000)
    const res = await request('POST', '/api/email/send', { from: sharedFrom, to: 'a@example.com, b@example.com', subject: 's', text: 't' }, auth)
    assert.strictEqual(res.status, 402)
    assert.strictEqual(res.data.error.code, 'insufficient_credits')
    assert.strictEqual(res.data.error.type, 'transactional')
    assert.strictEqual(await smsBalance(), 1005)
    assert.strictEqual(await tx(), 1)
  })

  await t.test('buying email credits: Paystack checkout, credited once, to the right balance', async () => {
    const list = await request('GET', '/api/email/credits', null, auth)
    assert.strictEqual(list.status, 200)
    assert.ok(list.data.pricing.transactional.packs.length)
    const bad = await request('POST', '/api/email/credits/checkout', { type: 'marketing', packId: 'tx-1k' }, auth)
    assert.strictEqual(bad.status, 400)
    const co = await request('POST', '/api/email/credits/checkout', { type: 'transactional', packId: 'tx-1k' }, auth)
    assert.strictEqual(co.status, 200, JSON.stringify(co.data))
    assert.ok(co.data.checkout_url)
    assert.ok(co.data.reference.startsWith('web_email_'))
    // The SMS verify endpoint must not credit an email purchase to the SMS wallet.
    const smsVerify = await request('GET', '/api/dashboard/verify-payment?reference=' + co.data.reference, null, auth)
    assert.strictEqual(smsVerify.status, 404)
    const v1 = await request('GET', '/api/email/credits/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(v1.status, 200)
    assert.strictEqual(v1.data.ok, true)
    assert.strictEqual(v1.data.emails, 1000)
    assert.strictEqual(v1.data.credits.transactional, 1001)
    const v2 = await request('GET', '/api/email/credits/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(v2.data.already, true)
    assert.strictEqual(await tx(), 1001, 'credited only once')
    assert.strictEqual(await mk(), 0)
    assert.strictEqual(await smsBalance(), 1005)
    // Another account can't settle someone else's purchase.
    const other = await UserRepo.create({ name: 'Other2', email: 'o2_' + email, phone: '', passwordHash: 'x', initialBalance: 0, isVerified: true })
    const steal = await request('GET', '/api/email/credits/verify?reference=' + co.data.reference, null, { Authorization: 'Bearer ' + generateToken(other) })
    assert.strictEqual(steal.status, 404)
    const hist = await request('GET', '/api/email/credits', null, auth)
    assert.strictEqual(hist.data.history[0].product, 'transactional')
    assert.strictEqual(hist.data.history[0].status, 'success')
  })

  await t.test('reserved and platform names are refused', async () => {
    assert.strictEqual((await request('POST', '/api/email/senders', { handle: 'support' }, auth)).status, 400)
    assert.strictEqual((await request('POST', '/api/email/domains', { name: 'mail.kebsend.com' }, auth)).status, 400)
  })

  const domain = `shop${Date.now()}.com.gh`
  await t.test('own domain: blocked until verified, then allowed', async () => {
    const add = await request('POST', '/api/email/domains', { name: 'https://' + domain }, auth)
    assert.strictEqual(add.status, 201)
    assert.strictEqual(add.data.domain.name, domain)
    assert.ok(add.data.domain.records.some(r => r.purpose === 'DKIM'))
    assert.ok(add.data.domain.records.some(r => r.purpose === 'DMARC' && r.optional))
    assert.strictEqual(add.data.domain.status, 'pending')
    const before = await request('POST', '/api/email/send', { from: `hello@${domain}`, to: 'x@example.com', subject: 's', text: 't' }, auth)
    assert.strictEqual(before.status, 403)
    assert.strictEqual(before.data.error.code, 'domain_not_verified')
    await sleep(1600) // mock DNS "propagates"
    const v = await request('POST', `/api/email/domains/${add.data.domain.id}/verify`, null, auth)
    assert.strictEqual(v.data.domain.status, 'verified')
    const after = await request('POST', '/api/email/send', { from: `Shop <hello@${domain}>`, to: 'x@example.com', subject: 's', html: '<b>t</b>' }, auth)
    assert.strictEqual(after.status, 202, JSON.stringify(after.data))
  })

  await t.test('a domain cannot be claimed by a second account', async () => {
    const other = await UserRepo.create({ name: 'Other', email: 'o_' + email, phone: '', passwordHash: 'x', initialBalance: 0, isVerified: true })
    const res = await request('POST', '/api/email/domains', { name: domain }, { Authorization: 'Bearer ' + generateToken(other) })
    assert.strictEqual(res.status, 409)
  })

  let emailKey
  await t.test('email API keys are scoped: email key cannot use SMS API, SMS key cannot send email', async () => {
    const k = await request('POST', '/api/email/api-keys', { name: 'Backend' }, auth)
    assert.strictEqual(k.status, 201)
    emailKey = k.data.apiKey.key
    const smsAttempt = await request('GET', '/api/v1/balance', null, { Authorization: 'Bearer ' + emailKey })
    assert.strictEqual(smsAttempt.status, 403)
    const smsSend = await request('POST', '/api/v1/send-sms', { to: '0241234567', message: 'hi' }, { Authorization: 'Bearer ' + emailKey })
    assert.strictEqual(smsSend.status, 403)
    const smsKey = await request('POST', '/api/dashboard/api-keys', { name: 'SMS' }, auth)
    const emailAttempt = await request('POST', '/api/v1/email/send', { from: `hello@${domain}`, to: 'x@example.com', subject: 's', text: 't' }, { Authorization: 'Bearer ' + smsKey.data.apiKey.key })
    assert.strictEqual(emailAttempt.status, 403)
    assert.strictEqual(emailAttempt.data.error.code, 'missing_scope')
    const smsStillWorks = await request('GET', '/api/v1/balance', null, { Authorization: 'Bearer ' + smsKey.data.apiKey.key })
    assert.strictEqual(smsStillWorks.status, 200)
    const overview = await request('GET', '/api/dashboard/overview', null, auth)
    assert.ok(overview.data.apiKeys.every(x => x.key !== emailKey), 'email keys stay off the SMS developer tab')
    const bal = await request('GET', '/api/v1/email/balance', null, { Authorization: 'Bearer ' + emailKey })
    assert.strictEqual(bal.status, 200)
    assert.strictEqual(typeof bal.data.credits.transactional, 'number')
    assert.strictEqual(typeof bal.data.credits.marketing, 'number')
  })

  await t.test('API send with idempotency key is charged once', async () => {
    const h = { Authorization: 'Bearer ' + emailKey, 'Idempotency-Key': 'order-77' }
    const body = { from: `hello@${domain}`, to: 'customer@example.com', subject: 'Payment Confirmation', html: '<h2>Your payment was successful.</h2>' }
    const b0 = await tx()
    const a = await request('POST', '/api/v1/email/send', body, h)
    const b = await request('POST', '/api/v1/email/send', body, h)
    assert.strictEqual(a.status, 202)
    assert.strictEqual(b.status, 200)
    assert.strictEqual(b.data.duplicate, true)
    assert.strictEqual(a.data.id, b.data.id)
    assert.strictEqual(b0 - (await tx()), 1)
  })

  await t.test('provider rejection refunds the email credits', async () => {
    const b0 = await tx()
    const res = await request('POST', '/api/v1/email/send', { from: `hello@${domain}`, to: 'reject@example.com', subject: 's', text: 't' }, { Authorization: 'Bearer ' + emailKey })
    assert.strictEqual(res.status, 202)
    await sleep(300)
    const m = await request('GET', '/api/v1/email/messages/' + res.data.id, null, { Authorization: 'Bearer ' + emailKey })
    assert.strictEqual(m.data.message.status, 'rejected')
    assert.strictEqual(m.data.message.refunded, true)
    assert.strictEqual(await tx(), b0)
    assert.strictEqual(await smsBalance(), 1005)
  })

  await t.test('hard bounce suppresses only the bounced address; later sends skip it free', async () => {
    const res = await request('POST', '/api/email/send', { from: `hello@${domain}`, to: 'bounce@example.com, good@example.com', subject: 's', text: 't' }, auth)
    assert.strictEqual(res.status, 202)
    await sleep(2000)
    const sup = await request('GET', '/api/email/suppressions', null, auth)
    const addrs = sup.data.suppressions.map(s => s.address)
    assert.ok(addrs.includes('bounce@example.com'))
    assert.ok(!addrs.includes('good@example.com'))
    const again = await request('POST', '/api/email/send', { from: `hello@${domain}`, to: 'bounce@example.com, good@example.com', subject: 's', text: 't' }, auth)
    assert.strictEqual(again.status, 202)
    assert.deepStrictEqual(again.data.message.to, ['good@example.com'])
    assert.strictEqual(again.data.message.credits_charged, 1)
    const none = await request('POST', '/api/email/send', { from: `hello@${domain}`, to: 'bounce@example.com', subject: 's', text: 't' }, auth)
    assert.strictEqual(none.status, 422)
  })

  await t.test('webhook events are applied once, and a late event never moves status backwards', async () => {
    const res = await request('POST', '/api/email/send', { from: `hello@${domain}`, to: 'late@example.com', subject: 's', text: 't' }, auth)
    await sleep(1600)
    const m = (await request('GET', '/api/email/messages/' + res.data.message.id, null, auth)).data.message
    assert.strictEqual(m.status, 'delivered')
    const evt = { id: 'evt_dup_1', type: 'email.opened', data: { email_id: m.provider_message_id } }
    const w1 = await request('POST', '/webhooks/resend', evt)
    const w2 = await request('POST', '/webhooks/resend', evt)
    assert.strictEqual(w1.data.applied, 'opened')
    assert.strictEqual(w2.data.duplicate, true)
    await request('POST', '/webhooks/resend', { id: 'evt_late_sent', type: 'email.sent', data: { email_id: m.provider_message_id } })
    const after = (await request('GET', '/api/email/messages/' + m.id, null, auth)).data.message
    assert.strictEqual(after.status, 'delivered')
    assert.strictEqual(after.opens, 1)
  })

  await t.test('templates render variables with HTML escaping', async () => {
    const tpl = await request('POST', '/api/email/templates', { name: 'OTP', subject: 'Code {{code}}', html: '<p>Hi {{name}}, code {{code}}</p>' }, auth)
    assert.deepStrictEqual(tpl.data.template.variables.sort(), ['code', 'name'])
    const res = await request('POST', '/api/v1/email/send', { from: `hello@${domain}`, to: 'otp@example.com', template_id: tpl.data.template._id, variables: { code: '4821', name: '<Kofi>' } }, { Authorization: 'Bearer ' + emailKey })
    assert.strictEqual(res.status, 202, JSON.stringify(res.data))
    const m = (await request('GET', '/api/email/messages/' + res.data.id, null, auth)).data.message
    assert.strictEqual(m.subject, 'Code 4821')
    assert.ok(m.html.includes('&lt;Kofi&gt;'))
  })

  await t.test('marketing email: own credits, one email per recipient, unsubscribe link', async () => {
    const body = { type: 'marketing', from: `News <hello@${domain}>`, to: 'one@example.com, two@example.com, bounce@example.com', subject: 'November deals', html: '<html><body><p>Hi {{email}}</p></body></html>' }
    const noCredits = await request('POST', '/api/email/send', body, auth)
    assert.strictEqual(noCredits.status, 402, 'transactional credits do not pay for marketing')
    assert.strictEqual(noCredits.data.error.type, 'marketing')
    const ccRes = await request('POST', '/api/email/send', { ...body, cc: 'x@example.com' }, auth)
    assert.strictEqual(ccRes.status, 400)

    const co = await request('POST', '/api/email/credits/checkout', { type: 'marketing', packId: 'mk-2k' }, auth)
    const v = await request('GET', '/api/email/credits/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(v.data.type, 'marketing')
    assert.strictEqual(await mk(), 2000)
    const tx0 = await tx()

    const res = await request('POST', '/api/v1/email/send', body, { Authorization: 'Bearer ' + emailKey, 'Idempotency-Key': 'nov-deals' })
    assert.strictEqual(res.status, 202, JSON.stringify(res.data))
    assert.strictEqual(res.data.type, 'marketing')
    assert.strictEqual(res.data.recipients, 2, 'suppressed address skipped')
    assert.strictEqual(res.data.credits_charged, 2)
    assert.strictEqual(await mk(), 1998)
    assert.strictEqual(await tx(), tx0, 'transactional credits untouched')
    const dup = await request('POST', '/api/v1/email/send', body, { Authorization: 'Bearer ' + emailKey, 'Idempotency-Key': 'nov-deals' })
    assert.strictEqual(dup.status, 200)
    assert.strictEqual(dup.data.campaign_id, res.data.campaign_id)
    assert.strictEqual(await mk(), 1998)

    await sleep(1600)
    const list = await request('GET', '/api/v1/email/messages?type=marketing', null, { Authorization: 'Bearer ' + emailKey })
    const mine = list.data.messages.filter(x => x.campaign_id === res.data.campaign_id)
    assert.strictEqual(mine.length, 2)
    assert.ok(mine.every(x => x.to.length === 1 && x.type === 'marketing' && x.status === 'delivered'))
    const detail = (await request('GET', '/api/email/messages/' + mine[0].id, null, auth)).data.message
    assert.ok(detail.html.includes('<p>Hi'), 'detail shows the campaign body')

    // What actually goes out: per-recipient body, footer and one-click headers.
    const c = { baseUrl: 'https://kebsend.test', userId, senderName: 'News', html: '<html><body><p>Hi {{email}}</p></body></html>', text: 'Hi {{email}}' }
    const out = engine.marketingBody(c, 'one@example.com')
    assert.ok(out.html.includes('Hi one@example.com'))
    assert.ok(out.html.includes('Unsubscribe</a></div></body>'))
    assert.ok(out.text.includes('Unsubscribe: https://kebsend.test/email/unsubscribe?'))
    assert.match(out.headers['List-Unsubscribe'], /^<https:\/\/kebsend\.test\/email\/unsubscribe\?/)
    assert.strictEqual(out.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')

    // Unsubscribing stops later marketing to that address.
    const url = new URL(engine.unsubscribeUrl('http://localhost:4011', userId, 'two@example.com'))
    const tampered = new URL(url); tampered.searchParams.set('u', 'someone_else')
    assert.strictEqual((await request('GET', tampered.pathname + tampered.search)).status, 400)
    const un = await request('POST', url.pathname + url.search)
    assert.strictEqual(un.status, 200)
    const again = await request('POST', '/api/email/send', { ...body, to: 'two@example.com' }, auth)
    assert.strictEqual(again.status, 422)
  })

  require('../web/src/email/engine').stopWorker()
  server.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
