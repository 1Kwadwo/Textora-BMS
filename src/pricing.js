const {
  COST_PER_SMS,
  SELLING_PRICE_PER_SMS
} = require('./config')

const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
const GSM7_EXTENDED = '^{}\\\\[~]|€'

function detectEncoding(message) {
  if (!message) return 'GSM'
  for (const char of message) {
    if (!GSM7_BASIC.includes(char) && !GSM7_EXTENDED.includes(char)) {
      return 'Unicode'
    }
  }
  return 'GSM'
}

function calculateSMSUnits(message) {
  if (!message || typeof message !== 'string') {
    return 0
  }
  const encoding = detectEncoding(message)
  
  if (encoding === 'GSM') {
    let length = 0
    for (const char of message) {
      if (GSM7_EXTENDED.includes(char)) {
        length += 2
      } else {
        length += 1
      }
    }
    
    if (length <= 160) {
      return 1
    }
    return Math.ceil(length / 153)
  } else {
    const length = message.length
    if (length <= 70) {
      return 1
    }
    return Math.ceil(length / 67)
  }
}

function calculateTotalSMSUnits(contactCount, smsUnits) {
  return contactCount * smsUnits
}

function calculateSMSPrice(contactCount, smsUnits) {

  const total =
    calculateTotalSMSUnits(contactCount, smsUnits) *
    SELLING_PRICE_PER_SMS

  return total.toFixed(2)
}

function calculateSMSCost(contactCount, smsUnits) {

  const cost =
    calculateTotalSMSUnits(contactCount, smsUnits) *
    COST_PER_SMS

  return cost.toFixed(2)
}

function calculateSMSProfit(contactCount, smsUnits) {

  const profit =
    calculateTotalSMSUnits(contactCount, smsUnits) *
    (SELLING_PRICE_PER_SMS - COST_PER_SMS)

  return profit.toFixed(2)
}

module.exports = {
  calculateSMSCost,
  calculateSMSProfit,
  calculateSMSPrice,
  calculateSMSUnits,
  calculateTotalSMSUnits,
  detectEncoding
}
