const crypto = require('crypto')
const http = require('http')

function startPaystackWebhookServer({ paystackWebhookPath, processPaystackPayment, secretKey }) {

  const port =
    Number(process.env.WEBHOOK_PORT || process.env.PORT || 3000)

  const server = http.createServer((req, res) => {

    const requestPath =
      req.url.split('?')[0]

    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (requestPath === '/' || requestPath === '/health')
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        req.method === 'HEAD'
          ? undefined
          : JSON.stringify({ ok: true, service: 'textora-bot' })
      )
      return
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
}

module.exports = {
  startPaystackWebhookServer
}
