const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const axios = require('axios')
const { createApiDevelopersStore } = require('../src/stores/apiDevelopers')
const { startPaystackWebhookServer } = require('../src/webhook')

const testDbPath = path.join(__dirname, 'api-developers-test.json')

test('Integration Test: API Endpoints', async (t) => {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath)
  }

  // Create store
  const apiDevelopersStore = createApiDevelopersStore({ apiDevelopersStorePath: testDbPath })

  // Initialize developer
  const dev = await apiDevelopersStore.createOrGetDeveloper('dev123', 'API Dev')
  await apiDevelopersStore.creditDeveloperBalance('dev123', 500) // credit 500 units

  // Mocks for services
  let sentSms = []
  const mockSendSMS = async (number, message, senderId) => {
    sentSms.push({ number, message, senderId })
    return { status: 'success', message_id: 'mock_123' }
  }

  let arkeselBalanceChecked = false
  const mockCheckArkeselBalance = async () => {
    arkeselBalanceChecked = true
    return 1000
  }

  const mockProcessPaystackPayment = async (reference) => {}

  // Set test port
  process.env.PORT = '3123'

  // Start server
  const server = startPaystackWebhookServer({
    paystackWebhookPath: '/paystack/webhook',
    processPaystackPayment: mockProcessPaystackPayment,
    secretKey: 'paystack_secret',
    checkArkeselBalance: mockCheckArkeselBalance,
    sendSMS: mockSendSMS,
    apiDevelopersStore,
    getVerifiedSenderIds: (userId) => ['kwadwocode'],
    initializePayment: async (userId, session) => ({ authorization_url: 'http://checkout', reference: 'ref123' }),
    paymentSessionStore: { rememberPaymentSession: async (ref, sess) => {} }
  })

  // Give server a moment to start
  await new Promise(resolve => setTimeout(resolve, 500))

  await t.test('GET /api/v1/balance - success', async () => {
    const res = await axios.get('http://localhost:3123/api/v1/balance', {
      headers: { 'Authorization': `Bearer ${dev.apiKey}` }
    })
    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(res.data.balance, 500)
  })

  await t.test('GET /api/v1/balance - unauthorized (invalid key)', async () => {
    try {
      await axios.get('http://localhost:3123/api/v1/balance', {
        headers: { 'Authorization': `Bearer invalid_key` }
      })
      assert.fail('Should have failed with 401')
    } catch (err) {
      assert.equal(err.response.status, 401)
      assert.equal(err.response.data.ok, false)
    }
  })

  await t.test('GET /api/v1/sender-ids - success', async () => {
    const res = await axios.get('http://localhost:3123/api/v1/sender-ids', {
      headers: { 'x-api-key': dev.apiKey }
    })
    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.deepEqual(res.data.senderIds, ['kwadwocode'])
  })

  await t.test('POST /api/v1/send-sms - success and debit', async () => {
    sentSms = []
    const res = await axios.post('http://localhost:3123/api/v1/send-sms', {
      to: '233201234567, 233207654321',
      message: 'Hello world', // 1 unit per recipient
      senderId: 'TESTER'
    }, {
      headers: { 'Authorization': `Bearer ${dev.apiKey}` }
    })

    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(res.data.total_units_debited, 2)
    assert.equal(res.data.remaining_balance, 498)
    assert.equal(sentSms.length, 2)
    assert.equal(sentSms[0].number, '233201234567')
    assert.equal(sentSms[0].senderId, 'TESTER')
  })

  await t.test('POST /api/v1/send-sms - insufficient balance', async () => {
    try {
      await axios.post('http://localhost:3123/api/v1/send-sms', {
        to: Array(500).fill('233201234567').join(','),
        message: 'Hello world'
      }, {
        headers: { 'Authorization': `Bearer ${dev.apiKey}` }
      })
      assert.fail('Should have failed with 400')
    } catch (err) {
      assert.equal(err.response.status, 400)
      assert.equal(err.response.data.ok, false)
      assert.ok(err.response.data.message.includes('Insufficient prepaid credits'))
    }
  })

  await t.test('POST /api/v1/recharge - success', async () => {
    const res = await axios.post('http://localhost:3123/api/v1/recharge', {
      planId: 2 // GHS 50
    }, {
      headers: { 'Authorization': `Bearer ${dev.apiKey}` }
    })
    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(res.data.amount_ghs, '50.00')
    assert.equal(res.data.credits, 1000)
    assert.equal(res.data.checkout_url, 'http://checkout')
    assert.equal(res.data.reference, 'ref123')
  })

  // Clean up
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath)
  }
  
  // Close HTTP server process
  await new Promise((resolve) => server.close(resolve))
})
