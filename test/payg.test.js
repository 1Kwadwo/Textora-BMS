const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kebsend-payg-'))
process.env.EMAIL_STORE_FILE = path.join(tmpDir, 'email-store.json')
process.env.EMAIL_PROVIDER = 'mock'
process.env.EMAIL_DAILY_CAP_UNPAID = '0'
process.env.EMAIL_FREE_TRANSACTIONAL = '0'
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789abcdef'
delete process.env.MONGODB_URI
delete process.env.PAYG_SMS_GHS
delete process.env.PAYG_MIN_GHS
process.env.WEB_PORT = '4013'

const { UserRepo, ApiKeyRepo, TransactionRepo } = require('../web/src/models')
const { hashPassword, generateToken } = require('../web/src/auth')
const payg = require('../web/src/payg')

const sleep = ms => new Promise(r => setTimeout(r, ms))
function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : ''
    const req = http.request(`http://localhost:4013${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
    }, res => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => { let j = {}; try { j = JSON.parse(data) } catch (e) { j = { raw: data } } resolve({ status: res.statusCode, data: j }) })
    })
    req.on('error', reject)
    if (body) req.write(payload)
    req.end()
  })
}

test('pay as you go: quote pays only the shortfall, with a minimum charge', () => {
  assert.strictEqual(payg.quote('sms', 10, 10), null, 'nothing to pay when the balance covers it')
  const q = payg.quote('sms', 120, 20)
  assert.strictEqual(q.credits, 100)
  assert.strictEqual(q.amountGHS, 6)
  const small = payg.quote('sms', 2, 0)
  assert.ok(small.amountGHS >= 1, 'GH₵ 1 minimum')
  assert.strictEqual(small.credits, 17)
  assert.strictEqual(payg.quote('transactional', 5, 0).rateGHS, 0.04)
  assert.strictEqual(payg.quote('marketing', 50, 0).amountGHS, 1.5)
})

test('pay as you go on the dashboard (SMS and email); API still needs a package', async t => {
  require('../web/server.js')
  const wallet = require('../web/src/email/wallet')
  await sleep(300)

  const user = await UserRepo.create({ name: 'Kojo Payg', email: `payg_${Date.now()}@kebsend.test`, phone: '', passwordHash: await hashPassword('x'), initialBalance: 1, isVerified: true })
  const userId = String(user._id || user.id)
  await UserRepo.addSenderId(userId, 'KOJOSHOP')
  const auth = { Authorization: 'Bearer ' + generateToken(user) }
  const smsBalance = async () => (await UserRepo.findById(userId)).balance
  const numbers = Array.from({ length: 30 }, (_, i) => '02441' + String(10000 + i)).join(', ')

  await t.test('SMS: short of credits returns a quote, paying sends it once', async () => {
    const send = await request('POST', '/api/dashboard/send-sms', { to: numbers, message: 'Hello', senderId: 'KOJOSHOP' }, auth)
    assert.strictEqual(send.status, 400)
    assert.strictEqual(send.data.payg.credits, 29)
    assert.strictEqual(send.data.payg.amountGHS, 1.74)
    assert.strictEqual(await smsBalance(), 1, 'nothing taken')

    const bad = await request('POST', '/api/dashboard/payg/sms', { to: numbers, message: 'Hello', senderId: 'NOTMINE' }, auth)
    assert.strictEqual(bad.status, 403, 'checked before any payment')

    const co = await request('POST', '/api/dashboard/payg/sms', { to: numbers, message: 'Hello', senderId: 'KOJOSHOP' }, auth)
    assert.strictEqual(co.status, 200, JSON.stringify(co.data))
    assert.ok(co.data.reference.startsWith('web_payg_'))
    assert.ok(co.data.checkout_url)
    assert.strictEqual(co.data.quote.amountGHS, 1.74)
    const tx = await TransactionRepo.findByReference(co.data.reference)
    assert.strictEqual(tx.amountGHS, 1.74)

    const v = await request('GET', '/api/payg/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(v.status, 200, JSON.stringify(v.data))
    assert.strictEqual(v.data.order.status, 'sent', JSON.stringify(v.data))
    assert.strictEqual(v.data.order.result.recipients, 30)
    assert.strictEqual(await smsBalance(), 0, 'old balance + paid credits = exactly this send')

    const again = await request('GET', '/api/payg/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(again.data.order.status, 'sent')
    assert.strictEqual(await smsBalance(), 0, 'credited and sent once')

    const logs = await request('GET', '/api/dashboard/logs', null, auth)
    assert.strictEqual(logs.data.logs.length, 1)
  })

  await t.test('another user cannot settle my order', async () => {
    const other = await UserRepo.create({ name: 'Other', email: `other_${Date.now()}@kebsend.test`, phone: '', passwordHash: await hashPassword('x'), isVerified: true })
    const co = await request('POST', '/api/dashboard/payg/sms', { to: '0244110000', message: 'Hi', senderId: 'KOJOSHOP' }, auth)
    const v = await request('GET', '/api/payg/verify?reference=' + co.data.reference, null, { Authorization: 'Bearer ' + generateToken(other) })
    assert.strictEqual(v.status, 404)
  })

  await t.test('enough credits: no checkout, just send', async () => {
    await UserRepo.creditBalance(userId, 100)
    const co = await request('POST', '/api/dashboard/payg/sms', { to: '0244110000', message: 'Hi', senderId: 'KOJOSHOP' }, auth)
    assert.strictEqual(co.status, 409)
  })

  await t.test('email: same flow, credits go to the right email balance', async () => {
    const s = await request('POST', '/api/email/senders', { handle: `kojo${Date.now() % 100000}`, displayName: 'Kojo Shop' }, auth)
    assert.strictEqual(s.status, 201, JSON.stringify(s.data))
    const mail = { type: 'marketing', from: s.data.sender.address, to: Array.from({ length: 40 }, (_, i) => `p${i}@example.com`).join(', '), subject: 'Sale', html: '<p>Hi</p>' }
    const send = await request('POST', '/api/email/send', mail, auth)
    assert.strictEqual(send.status, 402)
    assert.strictEqual(send.data.error.payg.product, 'marketing')
    assert.strictEqual(send.data.error.payg.credits, 40)
    assert.strictEqual(send.data.error.payg.amountGHS, 1.2)

    const co = await request('POST', '/api/email/payg', mail, auth)
    assert.strictEqual(co.status, 200, JSON.stringify(co.data))
    const v = await request('GET', '/api/payg/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(v.data.order.status, 'sent', JSON.stringify(v.data))
    assert.strictEqual(v.data.order.result.type, 'marketing')
    assert.strictEqual(v.data.order.result.recipients, 40)
    const b = await wallet.balances(userId)
    assert.strictEqual(b.marketing, 0)
    assert.strictEqual(b.transactional, 0)
    assert.strictEqual(await smsBalance(), 100, 'SMS wallet untouched')
  })

  await t.test('a send that fails after payment keeps the credits', async () => {
    const s = await request('GET', '/api/email/senders', null, auth)
    const mail = { from: s.data.senders[0].from || s.data.senders[0].address, to: 'a@example.com', subject: 'Hi', text: 'x' }
    const co = await request('POST', '/api/email/payg', mail, auth)
    assert.strictEqual(co.status, 200, JSON.stringify(co.data))
    // Make the stored send invalid before it is paid for.
    const { db } = require('../web/src/email/store')
    await db.payg.updateOne({ reference: co.data.reference }, { $set: { payload: { ...mail, subject: '' } } })
    const v = await request('GET', '/api/payg/verify?reference=' + co.data.reference, null, auth)
    assert.strictEqual(v.data.order.status, 'failed')
    assert.match(v.data.order.message, /credits are in your balance/)
    assert.strictEqual((await wallet.balances(userId)).transactional, co.data.quote.credits)
  })

  await t.test('API: no pay as you go, package credits only', async () => {
    const key = await ApiKeyRepo.generate(userId, 'k')
    await UserRepo.debitBalance(userId, await smsBalance())
    const res = await request('POST', '/api/v1/send-sms', { to: '0244110000', message: 'Hi', senderId: 'KOJOSHOP' }, { 'x-api-key': key.key })
    assert.strictEqual(res.status, 400)
    assert.strictEqual(res.data.payg, undefined)
  })
})

test.after(() => setTimeout(() => process.exit(0), 50))
