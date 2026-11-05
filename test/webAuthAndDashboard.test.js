const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { UserRepo } = require('../web/src/models')

test('KebSEND Web Auth, MongoDB Dashboard, API Keys & Paystack System', async (t) => {
  process.env.NODE_ENV = 'test'
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

  await t.test('1. User Registration: Requires 6-digit email code and holds 0 balance initially', async () => {
    const res = await request('POST', '/api/auth/register', {
      name: 'Harrison Kwadwo',
      email: testEmail,
      password: 'SecurePassword2026',
      phone: '0244123456'
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

    // Entering valid 6-digit code activates account and awards 5 free credits
    const verifyRes = await request('POST', '/api/auth/verify-code', {
      email: testEmail,
      code: unverifiedUser.verificationCode
    })
    assert.strictEqual(verifyRes.statusCode, 200)
    assert.strictEqual(verifyRes.data.ok, true)
    assert.ok(verifyRes.data.token)
    assert.strictEqual(verifyRes.data.user.email, testEmail)
    assert.strictEqual(verifyRes.data.user.balance, 5) // Free 5 starter credits awarded upon verification!
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

  await t.test('6. Developer Public API: Authenticates with generated ksnd_live key', async () => {
    const res = await request('GET', '/api/v1/balance', null, {
      Authorization: `Bearer ${generatedApiKey}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.balance, 5)
    assert.strictEqual(res.data.user_email, testEmail)
  })

  await t.test('7. Developer Public API: Dispatches SMS and debits balance', async () => {
    const res = await request('POST', '/api/v1/send-sms', {
      to: ['0244123456', '0501122334'],
      message: 'Testing KebSEND Developer API delivery!',
      senderId: 'TXTORA'
    }, {
      Authorization: `Bearer ${generatedApiKey}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.total_units_debited, 2)
    assert.strictEqual(res.data.remaining_balance, 3) // 5 - 2 = 3 credits
  })

  await t.test('8. Dashboard Web SMS: Dispatches SMS and verifies logs', async () => {
    const res = await request('POST', '/api/dashboard/send-sms', {
      to: '233240009988',
      message: 'Web dashboard broadcast SMS',
      senderId: 'TXTORA'
    }, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.units_debited, 1)
    assert.strictEqual(res.data.remaining_balance, 2) // 3 - 1 = 2 credits
  })

  await t.test('9. Wallet Top-up: Creates Paystack checkout and verifies credit increment', async () => {
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
    assert.strictEqual(verifyRes.data.newBalance, 1002) // 2 + 1000 = 1002 credits
  })

  await t.test('10. Custom Sender ID: Registers new brand name', async () => {
    const res = await request('POST', '/api/dashboard/sender-id', {
      senderId: 'MYSHOP',
      purpose: 'Order status alerts'
    }, {
      Authorization: `Bearer ${authToken}`
    })

    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)
    assert.strictEqual(res.data.senderIdRequest.senderId, 'MYSHOP')
  })

  await t.test('11. Forgot Password: Requests password reset link', async () => {
    const res = await request('POST', '/api/auth/forgot-password', {
      email: testEmail
    })
    assert.strictEqual(res.statusCode, 200)
    assert.strictEqual(res.data.ok, true)

    const user = await UserRepo.findByEmail(testEmail)
    assert.ok(user.resetToken)
    assert.ok(user.resetTokenExpiry)
  })

  await t.test('12. Reset Password: Uses token to update password and log in', async () => {
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
