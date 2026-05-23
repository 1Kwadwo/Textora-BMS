const path = require('path')

const rootDir =
  path.join(__dirname, '..')

const paystackWebhookPath =
  '/paystack/webhook'

const genericSenderId =
  process.env.GENERIC_SENDER_ID || 'txtora'

const customSenderIdFeeGHS =
  Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 1)

const COST_PER_SMS =
  Number(process.env.COST_PER_SMS || 0.0276)

const SELLING_PRICE_PER_SMS =
  Number(process.env.SELLING_PRICE_PER_SMS || 0.0699)

const senderIdStorePath =
  path.join(rootDir, 'sender-ids.json')

const pendingSenderIdStorePath =
  path.join(rootDir, 'pending-sender-id-sessions.json')

const paymentSessionStorePath =
  path.join(rootDir, 'payment-sessions.json')

module.exports = {
  COST_PER_SMS,
  customSenderIdFeeGHS,
  genericSenderId,
  paystackWebhookPath,
  pendingSenderIdStorePath,
  paymentSessionStorePath,
  SELLING_PRICE_PER_SMS,
  senderIdStorePath
}
