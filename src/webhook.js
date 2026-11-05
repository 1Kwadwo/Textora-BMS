const crypto = require('crypto')
const http = require('http')

function startPaystackWebhookServer({
  paystackWebhookPath,
  processPaystackPayment,
  secretKey,
  checkArkeselBalance,
  sendSMS,
  apiDevelopersStore,
  apiLogsStore,
  getVerifiedSenderIds,
  initializePayment,
  paymentSessionStore
}) {

  const port =
    Number(process.env.WEBHOOK_PORT || process.env.PORT || 3000)

  const server = http.createServer((req, res) => {

    const requestPath =
      req.url.split('?')[0]

    function json(status, data) {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }

    function getApiKey() {
      const authHeader = req.headers['authorization']
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7).trim()
      }
      const xApiKey = req.headers['x-api-key']
      if (xApiKey) {
        return xApiKey.trim()
      }
      return null
    }

    function parseJsonBody() {
      return new Promise((resolve, reject) => {
        const bodyChunks = []
        req.on('data', chunk => bodyChunks.push(chunk))
        req.on('end', () => {
          const bodyStr = Buffer.concat(bodyChunks).toString('utf8')
          if (!bodyStr) {
            resolve({})
            return
          }
          try {
            resolve(JSON.parse(bodyStr))
          } catch (err) {
            reject(new Error('Invalid JSON body'))
          }
        })
      })
    }

    if (requestPath.startsWith('/api/v1/')) {
      const apiKey = getApiKey()
      if (!apiKey) {
        return json(401, { ok: false, message: 'Missing API key. Use Authorization: Bearer <key> or x-api-key header.' })
      }

      apiDevelopersStore.getDeveloperByApiKey(apiKey).then(async (developer) => {
        if (!developer) {
          return json(401, { ok: false, message: 'Invalid API key.' })
        }

        try {
          if (req.method === 'GET' && requestPath === '/api/v1/balance') {
            return json(200, { ok: true, balance: developer.balance })
          }

          if (req.method === 'GET' && requestPath === '/api/v1/logs') {
            const logs = await apiLogsStore.getApiUsageLogs(developer.userId)
            return json(200, { ok: true, logs })
          }

          if (req.method === 'GET' && requestPath === '/api/v1/sender-ids') {
            const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
            const targetUserId = String(urlObj.searchParams.get('userId') || developer.userId)
            let senderIds = getVerifiedSenderIds ? getVerifiedSenderIds(targetUserId) : []
            if ((!senderIds || senderIds.length === 0)) {
              try {
                const { mongoose, getMongoStatus } = require('../web/src/db')
                if (getMongoStatus && getMongoStatus()) {
                  const doc = await mongoose.connection.db.collection('bot_sender_ids').findOne({ userId: targetUserId })
                  if (doc && Array.isArray(doc.senderIds) && doc.senderIds.length > 0) {
                    senderIds = doc.senderIds
                  } else {
                    const { ObjectId } = require('mongodb')
                    if (ObjectId.isValid(targetUserId)) {
                      const userDoc = await mongoose.connection.db.collection('users').findOne({ _id: new ObjectId(targetUserId) })
                      if (userDoc?.senderIds) senderIds = userDoc.senderIds
                    }
                  }
                }
              } catch (e) {}
            }
            return json(200, { ok: true, senderIds: senderIds.length > 0 ? senderIds : ['TXTORA'] })
          }

          if (req.method === 'POST' && requestPath === '/api/v1/send-sms') {
            let body
            try {
              body = await parseJsonBody()
            } catch (err) {
              return json(400, { ok: false, message: 'Invalid JSON body' })
            }

            const { to, message, senderId } = body
            if (!to || !message) {
              return json(400, { ok: false, message: 'Missing "to" or "message" parameter' })
            }

            let recipients = []
            if (Array.isArray(to)) {
              recipients = to.map(r => String(r).trim()).filter(Boolean)
            } else if (typeof to === 'string') {
              recipients = to.split(',').map(r => r.trim()).filter(Boolean)
            }

            if (recipients.length === 0) {
              return json(400, { ok: false, message: 'No valid recipients specified in "to"' })
            }

            const { calculateSMSUnits, isGhanaNumber } = require('./pricing')
            const msgUnits = calculateSMSUnits(message)
            
            let totalCreditsNeeded = 0
            for (const recipient of recipients) {
              if (isGhanaNumber(recipient)) {
                totalCreditsNeeded += msgUnits * 1.0
              } else {
                totalCreditsNeeded += msgUnits * 1.6
              }
            }
            totalCreditsNeeded = Number(totalCreditsNeeded.toFixed(2))

            const debitRes = await apiDevelopersStore.debitDeveloperBalance(apiKey, totalCreditsNeeded)
            if (!debitRes.ok) {
              return json(400, { ok: false, message: debitRes.message || 'Insufficient balance', balance: debitRes.balance })
            }

            const sendPromises = recipients.map(async (number) => {
              try {
                const res = await sendSMS(number, message, senderId)
                return { recipient: number, status: 'success', data: res }
              } catch (err) {
                return { recipient: number, status: 'failed', error: err.message }
              }
            })

            const results = await Promise.all(sendPromises)

            try {
              await apiLogsStore.logApiUsage(developer.userId, {
                message,
                recipientsCount: recipients.length,
                unitsDebited: totalCreditsNeeded,
                remainingBalance: debitRes.balance,
                status: 'success'
              })
            } catch (logErr) {
              console.log('Error logging API usage:', logErr.message)
            }

            return json(200, {
              ok: true,
              total_units_debited: totalCreditsNeeded,
              remaining_balance: debitRes.balance,
              results
            })
          }

          if (req.method === 'POST' && requestPath === '/api/v1/recharge') {
            let body
            try {
              body = await parseJsonBody()
            } catch (err) {
              return json(400, { ok: false, message: 'Invalid JSON body' })
            }

            const planId = parseInt(body.planId || body.plan_id, 10)
            const { API_RECHARGE_PLANS } = require('./config')
            const plan = API_RECHARGE_PLANS.find(p => p.id === planId)
            if (!plan) {
              return json(400, { ok: false, message: 'Invalid or missing planId. Supported planIds: ' + API_RECHARGE_PLANS.map(p => `${p.id} (GHS ${p.priceGHS})`).join(', ') })
            }

            const price = plan.priceGHS.toFixed(2)
            const credits = plan.credits

            const session = {
              price,
              credits,
              chatId: developer.userId,
              userId: developer.userId,
              paymentPurpose: 'textora_api_recharge',
              status: 'pending',
              step: 'waiting_for_payment'
            }

            const payment = await initializePayment(developer.userId, session)
            if (!payment?.authorization_url || !payment?.reference) {
              return json(500, { ok: false, message: 'Failed to initialize payment gateway' })
            }

            await paymentSessionStore.rememberPaymentSession(payment.reference, session)

            return json(200, {
              ok: true,
              plan_id: plan.id,
              amount_ghs: price,
              credits,
              checkout_url: payment.authorization_url,
              reference: payment.reference
            })
          }

          return json(404, { ok: false, message: 'Endpoint not found' })

        } catch (err) {
          return json(500, { ok: false, message: err.message })
        }
      }).catch(err => {
        return json(500, { ok: false, message: 'Internal Server Error: ' + err.message })
      })

      return
    }

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (requestPath === '/' || requestPath === '/health')
    ) {
      let isConnected = false
      let readyState = 0
      let mongoError = null
      let hasMongoUri = false
      try {
        const { mongoose, connectDB, getMongoStatus, getMongoError } = require('../web/src/db')
        hasMongoUri = Boolean(process.env.MONGODB_URI || process.env.MONGO_URI)
        if (!getMongoStatus() && hasMongoUri) {
          await connectDB().catch(() => {})
        }
        isConnected = Boolean(getMongoStatus && getMongoStatus())
        readyState = mongoose?.connection?.readyState || 0
        mongoError = getMongoError ? getMongoError() : null
      } catch (e) {
        mongoError = e.message
      }

      return json(200, {
        ok: true,
        service: 'textora-bot',
        hasMongoUri,
        mongoConnected: isConnected,
        mongoReadyState: readyState,
        mongoError
      })
    }

    if (req.method === 'GET' && requestPath === paystackWebhookPath) {
      res.writeHead(200)
      res.end('Textora Paystack webhook is running')
      return
    }

    if (req.method !== 'POST' || requestPath !== paystackWebhookPath) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const chunks = []

    req.on('data', chunk => {
      chunks.push(chunk)
    })

    req.on('end', () => {

      const rawBody =
        Buffer.concat(chunks)

      const signature =
        req.headers['x-paystack-signature']

      const expectedSignature =
        crypto
          .createHmac('sha512', secretKey)
          .update(rawBody)
          .digest('hex')

      const signatureIsValid =
        typeof signature === 'string' &&
        signature.length === expectedSignature.length &&
        crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(expectedSignature)
        )

      if (!signatureIsValid) {
        res.writeHead(401)
        res.end('Invalid signature')
        return
      }

      let event

      try {
        event = JSON.parse(rawBody.toString('utf8'))
      } catch (err) {
        res.writeHead(400)
        res.end('Invalid JSON')
        return
      }

      res.writeHead(200)
      res.end('OK')

      if (event.event === 'charge.success' && event.data?.reference) {
        processPaystackPayment(event.data.reference)
          .catch(err => {
            console.log(
              'PAYSTACK WEBHOOK FULFILLMENT ERROR:',
              err.message
            )
          })
      }
    })
  })

  server.on('error', err => {
    console.log(
      'PAYSTACK WEBHOOK SERVER ERROR:',
      err.message
    )
  })

  server.listen(port, () => {
    console.log(
      `Paystack webhook listening on port ${port}${paystackWebhookPath}`
    )
  })
  return server
}

module.exports = {
  startPaystackWebhookServer
}
