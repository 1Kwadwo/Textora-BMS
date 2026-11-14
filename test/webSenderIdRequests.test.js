const test = require('node:test')
const assert = require('node:assert')

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/none'
delete process.env.BOT_TOKEN

const { UserRepo, TransactionRepo, SenderIdRequestRepo } = require('../web/src/models')
const { fulfillSenderIdFee, reviewSenderIdRequest, reconcileUserSenderIdFees } = require('../web/src/services/senderIdRequests')
const { buildSenderIdAlert } = require('../web/src/services/telegramAlert')

async function makeUser() {
  return UserRepo.create({
    name: 'Citizen Gadgets',
    email: `sid_${Date.now()}_${Math.random().toString(36).slice(2)}@kebsend.test`,
    phone: '024' + String(Date.now()).slice(-7),
    passwordHash: 'x',
    isVerified: true
  })
}

test('admin alert escapes customer text so Telegram accepts it', () => {
  const { text, replyMarkup } = buildSenderIdAlert({
    user: { name: 'Citizen_gadgets *vault*', email: 'a_b@x.com', phone: '233244000000' },
    senderId: 'CGVAULT',
    purpose: 'Promos <sales> & offers_',
    requestId: 'abc123'
  })
  assert.match(text, /Promos &lt;sales&gt; &amp; offers_/)
  assert.strictEqual(replyMarkup.inline_keyboard[0][0].callback_data, 'approve_web_sid_abc123')
})

test('Paystack-paid fee becomes a pending request even if the customer never returns', async () => {
  const user = await makeUser()
  const userId = user._id || user.id
  const reference = 'sid_fee_' + Date.now() + '_t1'
  await TransactionRepo.create({ userId, reference, amountGHS: 8, credits: 0, paymentPurpose: 'sender_id_fee:CGVAULT:Shop%20alerts' })

  const results = await reconcileUserSenderIdFees(userId)
  assert.strictEqual(results.length, 1)
  assert.strictEqual(results[0].created, true)

  const again = await fulfillSenderIdFee(reference, { verified: true })
  assert.strictEqual(again.created, false)

  const list = await SenderIdRequestRepo.listByUser(userId)
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].senderId, 'CGVAULT')
  assert.strictEqual(list[0].purpose, 'Shop alerts')
  assert.strictEqual(list[0].status, 'pending')
})

test('webhook-confirmed fee (already success) still creates the request', async () => {
  const user = await makeUser()
  const userId = user._id || user.id
  const reference = 'sid_fee_' + Date.now() + '_t2'
  await TransactionRepo.create({ userId, reference, amountGHS: 8, credits: 0, paymentPurpose: 'sender_id_fee:SHOPGH:x' })
  await TransactionRepo.markSuccess(reference)
  const r = await fulfillSenderIdFee(reference)
  assert.strictEqual(r.created, true)
})

test('approving activates the ID, texts the customer, and only happens once', async () => {
  const user = await makeUser()
  const userId = user._id || user.id
  const req = await SenderIdRequestRepo.create({ userId, senderId: 'CGVAULT', purpose: 'x', feeAmountGHS: 8 })

  const pending = await SenderIdRequestRepo.listPending(500)
  assert.ok(pending.some(p => String(p._id) === String(req._id)))

  const r = await reviewSenderIdRequest(req._id, 'approve')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.request.status, 'approved')
  assert.ok(r.request.reviewedAt)
  assert.strictEqual(r.sms.ok, true)
  assert.match(r.sms.phone, /^233\d{9}$/)

  const fresh = await UserRepo.findById(userId)
  assert.ok(fresh.senderIds.includes('CGVAULT'))

  const twice = await reviewSenderIdRequest(req._id, 'reject')
  assert.strictEqual(twice.ok, false)
  assert.strictEqual(twice.reason, 'already_reviewed')
})

test('rejecting marks the request rejected without activating it', async () => {
  const user = await makeUser()
  const userId = user._id || user.id
  const req = await SenderIdRequestRepo.create({ userId, senderId: 'NOPEID', purpose: 'x', feeAmountGHS: 8 })
  const r = await reviewSenderIdRequest(req._id, 'reject')
  assert.strictEqual(r.request.status, 'rejected')
  const fresh = await UserRepo.findById(userId)
  assert.ok(!(fresh.senderIds || []).includes('NOPEID'))
})

test('admin lookup finds a customer by part of their name', async () => {
  const user = await makeUser()
  const found = await UserRepo.searchByNameOrEmail(user.email.slice(0, 20).toUpperCase())
  assert.ok(found.some(u => String(u._id) === String(user._id)))
  const txs = await TransactionRepo.listByUser(user._id)
  assert.ok(Array.isArray(txs))
})

test('admin lookup finds a customer by phone in any format and by a misspelled name', async () => {
  const stamp = String(Date.now()).slice(-7)
  const tag = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
  const user = await UserRepo.create({ name: tag + 'gadgetsvault' + stamp, email: `z${stamp}@kebsend.test`, phone: '233' + '20' + stamp, passwordHash: 'x', isVerified: true })
  for (const q of ['020 ' + stamp.slice(0, 3) + ' ' + stamp.slice(3), '+233 20' + stamp, '20' + stamp]) {
    const found = await UserRepo.searchByNameOrEmail(q)
    assert.ok(found.some(u => String(u._id) === String(user._id)), q)
  }
  const typo = await UserRepo.searchByNameOrEmail(tag + 'gadgetvault')
  assert.ok(typo.some(u => String(u._id) === String(user._id)))
})

test('admin lookup ignores spaces in names', async () => {
  const stamp = String(Date.now()).slice(-6)
  const user = await UserRepo.create({ name: `Wvy Gadgets Vault ${stamp}`, email: `w${stamp}@kebsend.test`, phone: '23324' + stamp + '1', passwordHash: 'x', isVerified: true })
  const found = await UserRepo.searchByNameOrEmail(`WvyGadgetsVault${stamp}`)
  assert.ok(found.some(u => String(u._id) === String(user._id)))
})

test('sender IDs with emoji are rejected; admin grant links an unused paid fee and approves', async () => {
  const { isValidWebSenderId, grantSenderId } = require('../web/src/services/senderIdRequests')
  assert.strictEqual(isValidWebSenderId('CITIZEN💻📱'), false)
  assert.strictEqual(isValidWebSenderId('12345'), false)
  assert.strictEqual(isValidWebSenderId('CITIZEN'), true)

  const user = await makeUser()
  const userId = String(user._id)
  const reference = 'sid_fee_' + Date.now() + '_grant'
  await TransactionRepo.create({ userId, reference, amountGHS: 8, credits: 0, paymentPurpose: 'sender_id_fee:CITIZEN%F0%9F%92%BB:x' })
  await TransactionRepo.markSuccess(reference)

  const r = await grantSenderId({ userId, senderId: 'citizen' })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.linkedPayment, reference)
  assert.strictEqual(r.request.status, 'approved')
  assert.strictEqual(r.sms.ok, true)
  const fresh = await UserRepo.findById(userId)
  assert.ok(fresh.senderIds.includes('CITIZEN'))
})

test('generic TXTORA is only usable by the allowed admin email', async () => {
  const { allowedSenderIdsFor } = require('../web/src/services/senderIdRequests')
  assert.deepStrictEqual(allowedSenderIdsFor({ email: 'someone@x.com', senderIds: ['TXTORA'] }), [])
  assert.deepStrictEqual(allowedSenderIdsFor({ email: 'someone@x.com', senderIds: ['TXTORA', 'shopgh'] }), ['SHOPGH'])
  assert.deepStrictEqual(allowedSenderIdsFor({ email: 'HarrisBraimah@iCloud.com', senderIds: [] }), ['TXTORA'])

  const user = await makeUser()
  assert.deepStrictEqual(user.senderIds, [])
  await UserRepo.addSenderId(user._id, 'TXTORA')
  const preview = await UserRepo.removeSenderIdFromAll('TXTORA', { exceptEmails: ['harrisbraimah@icloud.com'], dryRun: true })
  assert.ok(preview.emails.includes(user.email))
  assert.ok((await UserRepo.findById(user._id)).senderIds.includes('TXTORA'))
  await UserRepo.removeSenderIdFromAll('TXTORA', { exceptEmails: ['harrisbraimah@icloud.com'], dryRun: false })
  assert.ok(!(await UserRepo.findById(user._id)).senderIds.includes('TXTORA'))
})

test('rejecting tells the customer they can request another name for free', async () => {
  const user = await makeUser()
  const userId = String(user._id)
  const req = await SenderIdRequestRepo.create({ userId, senderId: 'BADNAME', purpose: 'x', feeAmountGHS: 0 })
  const r = await reviewSenderIdRequest(req._id, 'reject')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.request.status, 'rejected')
  assert.strictEqual(r.sms.ok, true)
})
