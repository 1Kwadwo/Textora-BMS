require('dotenv').config()

const { Telegraf } = require('telegraf')
const axios = require('axios')

const { registerBotHandlers } = require('./src/botHandlers')
const {
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
  userSessions
})

startPaystackWebhookServer({
  paystackWebhookPath,
  processPaystackPayment: paymentFlow.processPaystackPayment,
  secretKey: process.env.PAYSTACK_SECRET_KEY
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

bot.launch()

console.log('🚀 Textora Bot Running...')

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
