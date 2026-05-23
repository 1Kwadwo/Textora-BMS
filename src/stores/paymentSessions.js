const fs = require('fs')

function readJsonFile(filePath, fallback) {

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err) {
    return fallback
  }
}

function writeJsonFile(filePath, value) {

  fs.writeFileSync(
    filePath,
    JSON.stringify(value, null, 2)
  )
}

function createPaymentSessionStore({ paymentSessionStorePath }) {

  const paymentSessions =
    readJsonFile(paymentSessionStorePath, {})

  function savePaymentSessions() {

    writeJsonFile(paymentSessionStorePath, paymentSessions)
  }

  function rememberPaymentSession(reference, session) {

    paymentSessions[reference] = session
    savePaymentSessions()
  }

  function forgetPaymentSession(reference) {

    delete paymentSessions[reference]
    savePaymentSessions()
  }

  return {
    forgetPaymentSession,
    paymentSessions,
    rememberPaymentSession
  }
}

module.exports = {
  createPaymentSessionStore
}
