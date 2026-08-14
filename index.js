require('dotenv').config()

const os = require('os')
const { Telegraf } = require('telegraf')
const axios = require('axios')

const path = require('path')
const { registerBotHandlers } = require('./src/botHandlers')
const {
  API_RECHARGE_PLANS,
  customSenderIdFeeGHS,
  genericSenderId,
  paystackWebhookPath,
  paymentSessionStorePath,
  pendingSenderIdStorePath,
  senderIdStorePath,
  validateRuntimeConfig
} = require('./src/config')
const { createPaymentFlow } = require('./src/paymentFlow')
const { createArkeselService } = require('./src/services/arkesel')
const { createDeveloperService } = require('./src/services/developer')
const { createPaystackService } = require('./src/services/paystack')
const { createPaymentSessionStore } = require('./src/stores/paymentSessions')
const { createSenderIdStore } = require('./src/stores/senderIds')
const { createApiDevelopersStore } = require('./src/stores/apiDevelopers')
const { createApiLogsStore } = require('./src/stores/apiLogs')
const { startPaystackWebhookServer } = require('./src/webhook')
const { runRecoveryWorker } = require('./src/recoveryWorker')

validateRuntimeConfig()

const bot =
  new Telegraf(process.env.BOT_TOKEN)

const userSessions = {}

const senderIdStore =
  createSenderIdStore({
    pendingSenderIdStorePath,
    senderIdStorePath
  })

const paymentSessionStore =
  createPaymentSessionStore({
    paymentSessionStorePath
  })

const apiDevelopersStore =
  createApiDevelopersStore({
    apiDevelopersStorePath: path.join(__dirname, 'api-developers.json')
  })

const apiLogsStore =
  createApiLogsStore({
    apiLogsPath: path.join(__dirname, 'api-usage-log.json')
  })

const arkesel =
  createArkeselService({
    apiKey: process.env.ARKESEL_API_KEY,
    axios,
    genericSenderId
  })

const paystack =
  createPaystackService({
    axios,
    callbackUrl: process.env.PAYSTACK_CALLBACK_URL,
    secretKey: process.env.PAYSTACK_SECRET_KEY
  })

const developer =
  createDeveloperService({
    bot,
    customSenderIdFeeGHS,
    forgetPendingSenderIdSession: senderIdStore.forgetPendingSenderIdSession,
    rememberPendingSenderIdSession: senderIdStore.rememberPendingSenderIdSession
  })

const paymentFlow =
  createPaymentFlow({
    alertDeveloper: developer.alertDeveloper,
    bot,
    checkArkeselBalance: arkesel.checkArkeselBalance,
    customSenderIdFeeGHS,
    forgetPaymentSession: paymentSessionStore.forgetPaymentSession,
    initializePayment: paystack.initializePayment,
    genericSenderId,
    paymentSessions: paymentSessionStore,
    rememberPendingSenderIdSession: senderIdStore.rememberPendingSenderIdSession,
    rememberPaymentSession: paymentSessionStore.rememberPaymentSession,
    requestManualSenderIdApproval: developer.requestManualSenderIdApproval,
    sendSMS: arkesel.sendSMS,
    userSessions,
    verifyPayment: paystack.verifyPayment
  })

registerBotHandlers({
  axios,
  bot,
  createCheckout: paymentFlow.createCheckout,
  createSenderIdFeeCheckout: paymentFlow.createSenderIdFeeCheckout,
  customSenderIdFeeGHS,
  forgetPendingSenderIdSession: senderIdStore.forgetPendingSenderIdSession,
  genericSenderId,
  getVerifiedSenderIds: senderIdStore.getVerifiedSenderIds,
  paymentProcessor: paymentFlow.processPaystackPayment,
  pendingSenderIdSessions: senderIdStore.pendingSenderIdSessions,
  rememberVerifiedSenderId: senderIdStore.rememberVerifiedSenderId,
  userSessions,
  apiDevelopersStore,
  apiLogsStore,
  paymentSessionStore,
  initializePayment: paystack.initializePayment,
  rememberPaymentSession: paymentSessionStore.rememberPaymentSession,
  API_RECHARGE_PLANS
})

startPaystackWebhookServer({
  paystackWebhookPath,
  processPaystackPayment: paymentFlow.processPaystackPayment,
  secretKey: process.env.PAYSTACK_SECRET_KEY,
  checkArkeselBalance: arkesel.checkArkeselBalance,
  sendSMS: arkesel.sendSMS,
  apiDevelopersStore,
  apiLogsStore,
  getVerifiedSenderIds: senderIdStore.getVerifiedSenderIds,
  initializePayment: paystack.initializePayment,
  paymentSessionStore
})

runRecoveryWorker({
  paymentSessionStorePath,
  getSession: paymentSessionStore.getSession,
  updateSession: paymentSessionStore.updateSession,
  forgetSession: paymentSessionStore.forgetSession,
  recordDeliveryResult: async () => {}
}).catch(err => {
  console.log('CRASH RECOVERY WORKER ERROR:', err.message)
})

let retryTimeout = null
function retryLaunch() {
  if (retryTimeout) return
  console.log(`[${os.hostname()}][PID:${process.pid}] Scheduling bot launch retry in 10 seconds...`)
  retryTimeout = setTimeout(async () => {
    retryTimeout = null
    try {
      bot.stop()
    } catch (e) {}
    await startBot()
  }, 10000)
}

async function startBot() {
  try {
    await bot.launch()
    console.log(`[${os.hostname()}][PID:${process.pid}] 🚀 Textora Bot Running...`)
  } catch (err) {
    console.error(`[${os.hostname()}][PID:${process.pid}] Error launching bot:`, err.message)
    if (err.message && err.message.includes('409')) {
      console.log(`[${os.hostname()}][PID:${process.pid}] Conflict (409) detected during launch.`)
    }
    retryLaunch()
  }
}

process.on('uncaughtException', (err) => {
  console.error(`[${os.hostname()}][PID:${process.pid}] UNCAUGHT EXCEPTION:`, err)
  if (err && err.message && err.message.includes('409')) {
    console.log(`[${os.hostname()}][PID:${process.pid}] Telegram 409 conflict detected (terminated by other getUpdates). Retrying launch...`)
    retryLaunch()
  } else {
    process.exit(1)
  }
})

process.on('unhandledRejection', (reason, promise) => {
  console.error(`[${os.hostname()}][PID:${process.pid}] UNHANDLED REJECTION at:`, promise, 'reason:', reason)
  const message = reason?.message || String(reason)
  if (message.includes('409')) {
    console.log(`[${os.hostname()}][PID:${process.pid}] Telegram 409 conflict detected (unhandled rejection). Retrying launch...`)
    retryLaunch()
  }
})

startBot()

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

