const {
  COST_PER_SMS,
  SELLING_PRICE_PER_SMS
} = require('./config')

function calculateSMSUnits(message) {

  if (message.length <= 160) {
    return 1
  }

  return Math.ceil(message.length / 160)
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
  calculateTotalSMSUnits
}
