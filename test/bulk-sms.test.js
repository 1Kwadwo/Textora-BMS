const assert = require('node:assert/strict')
const test = require('node:test')

function loadPricing() {
  process.env.COST_PER_SMS ||= '0.0276'
  process.env.SELLING_PRICE_PER_SMS ||= '0.0589'
  delete require.cache[require.resolve('../src/config')]
  delete require.cache[require.resolve('../src/pricing')]
  return require('../src/pricing')
}

function createFlow(overrides = {}) {
  const messages = []
  const alerts = []
  const paymentSessions = {}
  const userSessions = {}
  const sent = []
  const deliveryResults = []

  const flow =
    require('../src/paymentFlow').createPaymentFlow({
      alertDeveloper: async (message) => alerts.push(message),
      bot: {
        telegram: {
          sendMessage: async (chatId, text) => {
            messages.push({ chatId, text })
          }
        }
      },
      checkArkeselBalance: async () => 100000,
      customSenderIdFeeGHS: 1,
      genericSenderId: 'ApprovedID',
      initializePayment: async () => ({
        authorization_url: 'https://paystack.test/pay',
        reference: 'ref_1'
      }),
      paymentSessions,
      recordDeliveryResult: async (session) => {
        deliveryResults.push({
          billedSMS: session.billedSMS,
          deliveredContacts: session.deliveredContacts,
          failedContacts: session.failedContacts,
          profit: session.profit
        })
      },
      rememberPendingSenderIdSession: () => {},
      requestManualSenderIdApproval: async () => ({
        requestId: 'sender_1',
        status: 'pending'
      }),
      sendSMS: async (number) => {
        sent.push(number)
        return { code: 'ok' }
      },
      userSessions,
      verifyPayment: async () => ({
        amount: 5890,
        currency: 'GHS',
        status: 'success'
      }),
      ...overrides
    })

  return {
    alerts,
    deliveryResults,
    flow,
    messages,
    paymentSessions,
    sent,
    userSessions
  }
}

function addPaymentSession(context, overrides = {}) {
  context.paymentSessions.ref_1 = {
    chatId: 1,
    contacts: Array.from({ length: 100 }, (_, i) => `23320${i}`),
    message: 'hello',
    paymentPurpose: 'textora_bulk_sms',
    price: '58.90',
    senderId: 'ApprovedID',
    senderIdType: 'generic',
    smsUnits: 1,
    userId: 10,
    ...overrides
  }
}

test('Test 1: 160 characters equals 1 SMS unit', () => {
  const { calculateSMSUnits } = loadPricing()

  assert.equal(calculateSMSUnits('x'.repeat(160)), 1)
})

test('Test 2: 161 characters equals 2 SMS units', () => {
  const { calculateSMSUnits } = loadPricing()

  assert.equal(calculateSMSUnits('x'.repeat(161)), 2)
})

test('Test 3: 320 characters equals at least 2 SMS units', () => {
  const { calculateSMSUnits } = loadPricing()

  assert.equal(calculateSMSUnits('x'.repeat(320)), 2)
})

test('Test 4: bulk send calculates 1000 recipients as 1000 SMS units', () => {
  const { calculateTotalSMSUnits } = loadPricing()

  assert.equal(calculateTotalSMSUnits(1000, 1), 1000)
})

test('Test 5: charge calculation uses selling price', () => {
  const { calculateSMSPrice } = loadPricing()

  assert.equal(calculateSMSPrice(1000, 1), '58.90')
})

test('Test 6: cost calculation uses provider cost', () => {
  const { calculateSMSCost } = loadPricing()

  assert.equal(calculateSMSCost(1000, 1), '27.60')
})

test('Test 7: profit calculation uses selling minus cost', () => {
  const { calculateSMSProfit } = loadPricing()

  assert.equal(calculateSMSProfit(1000, 1), '31.30')
})

test('Test 8: successful delivery records 100 billed SMS and 0 failed SMS', async () => {
  const context = createFlow()

  addPaymentSession(context)
  await context.flow.processPaystackPayment('ref_1')

  assert.equal(context.sent.length, 100)
  assert.deepEqual(context.deliveryResults.at(-1), {
    billedSMS: 100,
    deliveredContacts: 100,
    failedContacts: 0,
    profit: '3.13'
  })
  assert.equal(context.paymentSessions.ref_1, undefined)
})

test('Test 9: partial failure records 90 billed SMS and 10 failed SMS', async () => {
  let attempts = 0
  const context = createFlow({
    sendSMS: async () => {
      attempts += 1
      return attempts <= 90
        ? { code: 'ok' }
        : { code: 'failed' }
    }
  })

  addPaymentSession(context)
  await context.flow.processPaystackPayment('ref_1')

  assert.equal(attempts, 100)
  assert.deepEqual(context.deliveryResults.at(-1), {
    billedSMS: 90,
    deliveredContacts: 90,
    failedContacts: 10,
    profit: '2.82'
  })
  assert.equal(context.paymentSessions.ref_1, undefined)
})

test('Test 10: wallet deduction reduces balance correctly', () => {
  const { createWallet } = require('../src/wallet')
  const wallet = createWallet(100)

  assert.deepEqual(wallet.debit(69.9), {
    balance: 30.1,
    ok: true
  })
})

test('Test 11: insufficient wallet balance is blocked', () => {
  const { createWallet } = require('../src/wallet')
  const wallet = createWallet(30)

  assert.deepEqual(wallet.debit(69.9), {
    balance: 30,
    ok: false
  })
  assert.equal(wallet.getBalance(), 30)
})

test('Test 12: queue processes jobs FIFO', async () => {
  const { createJobQueue } = require('../src/jobQueue')
  const queue = createJobQueue()
  const processed = []

  queue.enqueue({ id: 'first' })
  queue.enqueue({ id: 'second' })

  await queue.processNext(async (job) => processed.push(job.id))
  await queue.processNext(async (job) => processed.push(job.id))

  assert.deepEqual(processed, ['first', 'second'])
})

test('Test 13: failed queue jobs retry up to 3 times maximum', async () => {
  const { createJobQueue } = require('../src/jobQueue')
  const queue = createJobQueue({ maxRetries: 3 })
  let attempts = 0

  queue.enqueue({ id: 'retry-me' })
  await queue.processNext(async () => {
    attempts += 1
    throw new Error('temporary')
  })
  await queue.processNext(async () => {
    attempts += 1
    throw new Error('temporary')
  })
  const result = await queue.processNext(async () => {
    attempts += 1
    throw new Error('temporary')
  })

  assert.equal(attempts, 3)
  assert.equal(result.status, 'failed')
})

test('Test 14: pricing does not use a fixed 1 GHS SMS charge', () => {
  const { calculateSMSPrice } = loadPricing()

  assert.notEqual(calculateSMSPrice(1, 1), '1.00')
  assert.equal(calculateSMSPrice(1, 1), '0.06')
})

test('Test 15: pricing changes through config without code changes', () => {
  const originalPrice = process.env.SELLING_PRICE_PER_SMS

  process.env.SELLING_PRICE_PER_SMS = '0.10'
  const { calculateSMSPrice } = loadPricing()
  assert.equal(calculateSMSPrice(1000, 1), '100.00')

  if (originalPrice === undefined) {
    delete process.env.SELLING_PRICE_PER_SMS
  } else {
    process.env.SELLING_PRICE_PER_SMS = originalPrice
  }
})

test('Test 16: runtime config requires an explicit generic sender ID', () => {
  const envNames = [
    'BOT_TOKEN',
    'ARKESEL_API_KEY',
    'PAYSTACK_SECRET_KEY',
    'GENERIC_SENDER_ID',
    'COST_PER_SMS',
    'SELLING_PRICE_PER_SMS'
  ]
  const originalEnv =
    Object.fromEntries(envNames.map(name => [name, process.env[name]]))

  try {
    process.env.BOT_TOKEN = 'bot-token'
    process.env.ARKESEL_API_KEY = 'arkesel-key'
    process.env.PAYSTACK_SECRET_KEY = 'paystack-secret'
    process.env.COST_PER_SMS = '0.0276'
    process.env.SELLING_PRICE_PER_SMS = '0.0589'
    delete process.env.GENERIC_SENDER_ID

    delete require.cache[require.resolve('../src/config')]
    const { genericSenderId, validateRuntimeConfig } = require('../src/config')

    assert.equal(genericSenderId, '')
    assert.throws(
      () => validateRuntimeConfig(),
      /GENERIC_SENDER_ID/
    )
  } finally {
    envNames.forEach(name => {
      if (originalEnv[name] === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = originalEnv[name]
      }
    })
    delete require.cache[require.resolve('../src/config')]
  }
})

test('Test 20: runtime config requires pricing environment variables', () => {
  const envNames = [
    'BOT_TOKEN',
    'ARKESEL_API_KEY',
    'PAYSTACK_SECRET_KEY',
    'GENERIC_SENDER_ID',
    'COST_PER_SMS',
    'SELLING_PRICE_PER_SMS'
  ]
  const originalEnv =
    Object.fromEntries(envNames.map(name => [name, process.env[name]]))

  try {
    process.env.BOT_TOKEN = 'bot-token'
    process.env.ARKESEL_API_KEY = 'arkesel-key'
    process.env.PAYSTACK_SECRET_KEY = 'paystack-secret'
    process.env.GENERIC_SENDER_ID = 'ApprovedID'
    process.env.COST_PER_SMS = '0.0276'
    delete process.env.SELLING_PRICE_PER_SMS

    delete require.cache[require.resolve('../src/config')]
    const { validateRuntimeConfig } = require('../src/config')

    assert.throws(
      () => validateRuntimeConfig(),
      /SELLING_PRICE_PER_SMS/
    )
  } finally {
    envNames.forEach(name => {
      if (originalEnv[name] === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = originalEnv[name]
      }
    })
    delete require.cache[require.resolve('../src/config')]
  }
})

test('Test 17: invalid sender ID keeps a paid SMS session retryable', async () => {
  let attempts = 0
  const context = createFlow({
    sendSMS: async () => {
      attempts += 1
      return { code: 106 }
    }
  })

  addPaymentSession(context)
  await context.flow.processPaystackPayment('ref_1')

  assert.equal(attempts, 1)
  assert.equal(context.paymentSessions.ref_1.step, 'waiting_for_sender_id_fix')
  assert.equal(context.paymentSessions.ref_1.contacts.length, 100)
  assert.equal(context.paymentSessions.ref_1.senderId, 'ApprovedID')
  assert.match(context.alerts.at(-1), /ARKESEL REJECTED SENDER ID/)
  assert.deepEqual(context.deliveryResults.at(-1), {
    billedSMS: 0,
    deliveredContacts: 0,
    failedContacts: 0,
    profit: '0.00'
  })
})

test('Test 18: raw Arkesel OK response counts as delivered', async () => {
  let attempts = 0
  const context = createFlow({
    sendSMS: async () => {
      attempts += 1
      return 'OK'
    }
  })

  addPaymentSession(context)
  await context.flow.processPaystackPayment('ref_1')

  assert.equal(attempts, 100)
  assert.equal(context.deliveryResults.at(-1).deliveredContacts, 100)
  assert.equal(context.paymentSessions.ref_1, undefined)
})

test('Test 19: full system flow passes splitting, billing, wallet, delivery, profit, queue, and resume rules', async () => {
  const {
    calculateSMSPrice,
    calculateSMSProfit,
    calculateSMSUnits
  } = loadPricing()
  const { createJobQueue } = require('../src/jobQueue')
  const { createWallet } = require('../src/wallet')
  let call = 0
  let expectedAmount = 0
  const context = createFlow({
    verifyPayment: async () => ({
      amount: expectedAmount,
      currency: 'GHS',
      status: 'success'
    }),
    sendSMS: async () => {
      call += 1
      return call === 3
        ? { code: '105' }
        : { code: 'ok' }
    }
  })
  const contacts = ['1', '2', '3', '4']
  const smsUnits = calculateSMSUnits('x'.repeat(160))
  const price = calculateSMSPrice(contacts.length, smsUnits)
  expectedAmount = Math.round(Number(price) * 100)
  const wallet = createWallet(10)
  const queue = createJobQueue()

  assert.equal(wallet.debit(Number(price)).ok, true)
  assert.equal(calculateSMSProfit(contacts.length, smsUnits), '0.13')

  queue.enqueue({ id: 'bulk-1' })
  assert.equal((await queue.processNext(async () => {})).status, 'completed')

  addPaymentSession(context, {
    contacts,
    price
  })

  await context.flow.processPaystackPayment('ref_1')
  assert.equal(context.paymentSessions.ref_1.contacts.length, 2)
  assert.equal(context.paymentSessions.ref_1.deliveredContacts, 2)

  await context.flow.processPaystackPayment('ref_1')
  assert.equal(context.paymentSessions.ref_1, undefined)
  assert.equal(call, 5)
})
