const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { UserRepo } = require('../web/src/models')

test('KebSEND Web Auth, MongoDB Dashboard, API Keys & Paystack System', async (t) => {
  process.env.NODE_ENV = 'test'
  delete process.env.MONGODB_URI
  process.env.WEB_PORT = '4008'
  const server = require('../web/server.js')

  await new Promise(resolve => setTimeout(resolve, 400))

  function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : ''
      const reqHeaders = {
        'Content-Type': 'application/json',
        ...headers
      }
      if (body) {
        reqHeaders['Content-Length'] = Buffer.byteLength(payload)
      }

      const req = http.request(`http://localhost:4008${path}`, {
        method,
        headers: reqHeaders
      }, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          let json = {}
          try { json = JSON.parse(data) } catch (e) { json = { raw: data } }
          resolve({ statusCode: res.statusCode, headers: res.headers, data: json })
        })
      })

      req.on('error', reject)
      if (body) req.write(payload)
      req.end()
    })
  }

  let authToken = ''
  let createdUserId = ''
  let generatedApiKey = ''
  const testEmail = `test_${Date.now()}@kebsend.test`
  // A fresh number each run, written as a customer would type it (0 + 9 digits)
  const testPhone = '024' + String(Date.now()).slice(-7)

  await t.test('1. User Registration: Requires 6-digit email code and holds 0 balance initially', async () => {
    const res = await request('POST', '/api/auth/register', {
      name: 'Harrison Kwadwo',
      email: testEmail,
      password: 'SecurePassword2026',
      phone: testPhone
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.requiresVerification, true)
    assert.strictEqual(res.data.email, testEmail)

    // Verify unverified user has 0 balance and cannot login yet
    const unverifiedUser = await UserRepo.findByEmail(testEmail)
    assert.strictEqual(unverifiedUser.isVerified, false)
    assert.strictEqual(unverifiedUser.balance, 0)
    assert.ok(unverifiedUser.verificationCode)
    assert.strictEqual(unverifiedUser.verificationCode.length, 6)

    // Attempting login before verification is blocked with 403
    const blockedLogin = await request('POST', '/api/auth/login', {
      email: testEmail,
      password: 'SecurePassword2026'
    })
    assert.strictEqual(blockedLogin.statusCode, 403)
    assert.strictEqual(blockedLogin.data.requiresVerification, true)

    // Entering incorrect code is rejected
    const badCodeRes = await request('POST', '/api/auth/verify-code', {
      email: testEmail,
      code: '000000'
    })
    assert.strictEqual(badCodeRes.statusCode, 400)
    assert.strictEqual(badCodeRes.data.ok, false)

    // Entering valid 6-digit code activates account and keeps balance at 0 (top-up required)
    const verifyRes = await request('POST', '/api/auth/verify-code', {
      email: testEmail,
      code: unverifiedUser.verificationCode
    })
    assert.strictEqual(verifyRes.statusCode, 200)
    assert.strictEqual(verifyRes.data.ok, true)
    assert.ok(verifyRes.data.token)
    assert.strictEqual(verifyRes.data.user.email, testEmail)
    assert.strictEqual(verifyRes.data.user.balance, 0) // No free starter credits; top-up required
    assert.ok(verifyRes.data.initialApiKey.startsWith('ksnd_live_'))

    authToken = verifyRes.data.token
    createdUserId = verifyRes.data.user.id
    generatedApiKey = verifyRes.data.initialApiKey
  })

  await t.test('2. User Registration: Blocks duplicate email', async () => {
    const res = await request('POST', '/api/auth/register', {
      name: 'Duplicate Guy',
      email: testEmail,
      password: 'AnotherPassword'
    })

    assert.strictEqual(res.statusCode, 400)
    assert.strictEqual(res.data.ok, false)
    assert.ok(res.data.message.includes('already exists'))
  })

  await t.test('2b. User Registration: Blocks a phone number already on another account, in any format', async () => {
    const formats = [
      testPhone,
      '+233 ' + testPhone.slice(1, 3) + ' ' + testPhone.slice(3, 6) + ' ' + testPhone.slice(6),
      '233' + testPhone.slice(1)
    ]
    for (const [i, phone] of formats.entries()) {
      const res = await request('POST', '/api/auth/register', {
        name: 'Second Account',
        email: `other_${i}_${Date.now()}@kebsend.test`,
        password: 'AnotherPassword',
        phone
      })
      assert.strictEqual(res.statusCode, 409, `format ${phone} should be rejected`)
      assert.strictEqual(res.data.ok, false)
      assert.ok(res.data.message.includes('already linked'))
    }
  })

  await t.test('2c. User Registration: Rejects an invalid phone number and holds a number pending on another sign-up', async () => {
    const bad = await request('POST', '/api/auth/register', {
      name: 'Bad Number', email: `bad_${Date.now()}@kebsend.test`, password: 'Password123', phone: '12345'
    })
    assert.strictEqual(bad.statusCode, 400)

    const pendingPhone = '055' + String(Date.now() + 7).slice(-7)
    const first = await request('POST', '/api/auth/register', {
      name: 'Pending One', email: `pend1_${Date.now()}@kebsend.test`, password: 'Password123', phone: pendingPhone
    })
    assert.strictEqual(first.statusCode, 200)
    const second = await request('POST', '/api/auth/register', {
      name: 'Pending Two', email: `pend2_${Date.now()}@kebsend.test`, password: 'Password123', phone: pendingPhone
    })
    assert.strictEqual(second.statusCode, 409)
    assert.ok(second.data.message.includes('waiting to be verified'))
  })

  await t.test('3. User Login: Validates credentials and returns JWT', async () => {
    const res = await request('POST', '/api/auth/login', {
      email: testEmail,
      password: 'SecurePassword2026'
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.ok(res.data.token)
    assert.strictEqual(res.data.user.name, 'Harrison Kwadwo')
  })

  await t.test('4. Authenticated Profile: GET /api/auth/me', async () => {
    const res = await request('GET', '/api/auth/me', null, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.user.email, testEmail)
  })

  await t.test('5. API Key Generation: Generates secondary key via Dashboard', async () => {
    const res = await request('POST', '/api/dashboard/api-keys', {
      name: 'Production Server Key'
    }, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.ok(res.data.apiKey.key.startsWith('ksnd_live_'))
    assert.strictEqual(res.data.apiKey.name, 'Production Server Key')
  })

  await t.test('6. Developer Public API: Authenticates with generated ksnd_live key and reports 0 balance', async () => {
    const res = await request('GET', '/api/v1/balance', null, {
      Authorization: `Bearer ${generatedApiKey}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.balance, 0)
    assert.strictEqual(res.data.user_email, testEmail)
  })

  await t.test('6b. Sender IDs: generic TXTORA is not handed to new accounts', async () => {
    const res = await request('POST', '/api/v1/send-sms', {
      to: ['0244123456'],
      message: 'Should be refused',
      senderId: 'TXTORA'
    }, {
      Authorization: `Bearer ${generatedApiKey}`
    })
    assert.strictEqual(res.statusCode, 403)
    assert.strictEqual(res.data.ok, false)
    // Give the account its own approved sender ID for the sending tests below.
    await UserRepo.addSenderId(createdUserId, 'TESTSHOP')
  })

  await t.test('7. Developer Public API: Blocks SMS when balance is zero', async () => {
    const res = await request('POST', '/api/v1/send-sms', {
      to: ['0244123456', '0501122334'],
      message: 'Testing KebSEND Developer API delivery!',
      senderId: 'TESTSHOP'
    }, {
      Authorization: `Bearer ${generatedApiKey}`
    })

    assert.strictEqual(res.statusCode, 400)
    assert.strictEqual(res.data.ok, false)
    assert.ok(res.data.message.includes('Insufficient'))
  })

  await t.test('8. Wallet Top-up: Creates Paystack checkout and verifies credit increment', async () => {
    // 1. Initialize recharge
    const rechargeRes = await request('POST', '/api/dashboard/recharge', {
      planId: 2 // GH₵ 50 = 1,000 Credits
    }, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(rechargeRes.statusCode, 200)
    assert.strictEqual(rechargeRes.data.ok, true)
    assert.ok(rechargeRes.data.reference)
    assert.strictEqual(rechargeRes.data.credits, 1000)

    // 2. Verify payment
    const verifyRes = await request('GET', `/api/dashboard/verify-payment?reference=${rechargeRes.data.reference}`, null, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(verifyRes.statusCode, 200)
    assert.strictEqual(verifyRes.data.ok, true)
    assert.strictEqual(verifyRes.data.creditsAdded, 1000)
    assert.strictEqual(verifyRes.data.newBalance, 1000) // 0 + 1000 = 1000 credits
  })

  await t.test('9. Developer Public API: Dispatches SMS and debits balance after top-up', async () => {
    const res = await request('POST', '/api/v1/send-sms', {
      to: ['0244123456', '0501122334'],
      message: 'Testing KebSEND Developer API delivery!',
      senderId: 'TESTSHOP'
    }, {
      Authorization: `Bearer ${generatedApiKey}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.total_units_debited, 2)
    assert.strictEqual(res.data.remaining_balance, 998) // 1000 - 2 = 998 credits
  })

  await t.test('10. Dashboard Web SMS: Dispatches SMS and verifies logs', async () => {
    const res = await request('POST', '/api/dashboard/send-sms', {
      to: '233240009988',
      message: 'Web dashboard broadcast SMS',
      senderId: 'TESTSHOP'
    }, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.units_debited, 1)
    assert.strictEqual(res.data.remaining_balance, 997) // 998 - 1 = 997 credits
  })

  await t.test('11. Custom Sender ID: Registers new brand name', async () => {
    const res = await request('POST', '/api/dashboard/sender-id', {
      senderId: 'MYSHOP',
      purpose: 'Order status alerts'
    }, {
      Authorization: `Bearer ${authToken}`
    })

    // Sender IDs are free: no Paystack, no SMS credits touched.
    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.senderIdRequest.senderId, 'MYSHOP')
    assert.strictEqual(res.data.senderIdRequest.feeAmountGHS, 0)
    assert.ok(!res.data.paymentRequired)
    assert.strictEqual((await UserRepo.findById(createdUserId)).balance, 997)

    // Not usable until the admin approves it.
    const early = await request('POST', '/api/dashboard/send-sms', {
      to: '233240009988', message: 'too early', senderId: 'MYSHOP'
    }, { Authorization: `Bearer ${authToken}` })
    assert.strictEqual(early.statusCode, 403)

    // At most 3 requests can wait at once.
    for (const sid of ['SHOPTWO', 'SHOPTHREE']) {
      const r = await request('POST', '/api/dashboard/sender-id', { senderId: sid, purpose: 'x' }, { Authorization: `Bearer ${authToken}` })
      assert.strictEqual(r.statusCode, 200)
    }
    const fourth = await request('POST', '/api/dashboard/sender-id', { senderId: 'SHOPFOUR', purpose: 'x' }, { Authorization: `Bearer ${authToken}` })
    assert.strictEqual(fourth.statusCode, 400)
  })

  await t.test('12. Forgot Password: Requests password reset link', async () => {
    const res = await request('POST', '/api/auth/forgot-password', {
      email: testEmail
    })
    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)

    const user = await UserRepo.findByEmail(testEmail)
    assert.ok(user.resetToken)
    assert.ok(user.resetTokenExpiry)
  })

  await t.test('13. Reset Password: Uses token to update password and log in', async () => {
    const user = await UserRepo.findByEmail(testEmail)
    const token = user.resetToken
    const newPassword = 'NewSecretPassword2026!'

    const resetRes = await request('POST', '/api/auth/reset-password', {
      token,
      password: newPassword
    })
    assert.strictEqual(resetRes.statusCode, 200)
    assert.strictEqual(resetRes.data.ok, true)

    // Verify user can now log in with the new password
    const loginRes = await request('POST', '/api/auth/login', {
      email: testEmail,
      password: newPassword
    })
    assert.strictEqual(loginRes.statusCode, 200)
    assert.strictEqual(loginRes.data.ok, true)
    assert.ok(loginRes.data.token)
  })

  if (server.closeAllConnections) server.closeAllConnections()
  server.close()
  await require('mongoose').disconnect().catch(() => {})
  setTimeout(() => process.exit(0), 100).unref()
})
