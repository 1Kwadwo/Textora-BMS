const fs = require('fs').promises
const path = require('path')
const { withLock } = require('./lockManager')
const { getSmsLogStatus } = require('./stores/smsLogger')

async function readJsonFileAsync(filePath, fallback) {
  try {
    const data = await fs.readFile(filePath, 'utf8')
    return JSON.parse(data)
  } catch (err) {
    return fallback
  }
}

async function runRecoveryWorker({
  paymentSessionStorePath,
  getSession,
  updateSession,
  forgetSession,
  recordDeliveryResult
}) {
  console.log('🔄 Starting Textora Crash Recovery Worker...')
  
  const sessions = await readJsonFileAsync(paymentSessionStorePath, {})
  const references = Object.keys(sessions)

  for (const reference of references) {
    await withLock(`tx_${reference}`, async () => {
      const session = await getSession(reference)
      if (!session) return

      if (session.status === 'processing') {
        const processingTime = Date.now() - Number(session.processingTimestamp || 0)
        
        // Stuck for more than 120 seconds
        if (!session.processingTimestamp || processingTime > 120000) {
          console.log(`⚠️ Transaction ${reference} is stuck in processing (${Math.round(processingTime / 1000)}s age). Starting recovery...`)

          let allSent = true
          for (const number of session.contacts) {
            const logEntry = await getSmsLogStatus(reference, number)
            if (!logEntry || logEntry.status !== 'sent') {
              allSent = false
              break
            }
          }

          if (allSent) {
            console.log(`✅ All SMS were successfully sent for transaction ${reference}. Marking as sent/completed.`)
            
            await updateSession(reference, s => {
              s.status = 'sent'
              return s
            })

            const currentSession = await getSession(reference)
            await recordDeliveryResult(currentSession)
            await forgetSession(reference)
          } else {
            console.log(`⚠️ SMS delivery was incomplete or crashed for transaction ${reference}. Resetting to paused.`)
            await updateSession(reference, s => {
              s.status = 'paused'
              s.step = 'waiting_for_arkesel_credit_refill'
              return s
            })
          }
        }
      }
    })
  }

  console.log('🔄 Textora Crash Recovery Worker completed.')
}

module.exports = {
  runRecoveryWorker
}
