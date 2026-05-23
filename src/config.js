const path = require('path')
const { validateSenderId } = require('./senderIds')

const rootDir =
  path.join(__dirname, '..')

const paystackWebhookPath =
  '/paystack/webhook'

function readEnv(name) {
  const value =
    process.env[name]

  return typeof value === 'string'
    ? value.trim()
    : ''
}

function validateRuntimeConfig() {
  const requiredEnvNames =
    [
      'BOT_TOKEN',
      'ARKESEL_API_KEY',
      'PAYSTACK_SECRET_KEY',
      'GENERIC_SENDER_ID'
    ]

  const missingEnvNames =
    requiredEnvNames.filter(name => !readEnv(name))

  if (missingEnvNames.length > 0) {
    throw new Error(
      'Missing required environment variable' +
      (missingEnvNames.length === 1 ? '' : 's') +
      ': ' +
      missingEnvNames.join(', ') +
      '. Set them in the hosting environment. The app does not fall back to txtora because Arkesel rejects unapproved sender IDs.'
    )
  }

  const genericSenderValidation =
    validateSenderId(readEnv('GENERIC_SENDER_ID'))

  if (!genericSenderValidation.valid) {
    throw new Error(
      'Invalid GENERIC_SENDER_ID: ' +
      genericSenderValidation.message
    )
  }
}

const genericSenderId =
  readEnv('GENERIC_SENDER_ID')

const customSenderIdFeeGHS =
  Number(process.env.CUSTOM_SENDER_ID_FEE_GHS || 1)

const COST_PER_SMS =
  Number(process.env.COST_PER_SMS || 0.0276)

const SELLING_PRICE_PER_SMS =
  Number(process.env.SELLING_PRICE_PER_SMS || 0.0589)

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
  senderIdStorePath,
  validateRuntimeConfig
}
