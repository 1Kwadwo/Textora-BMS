const axios = require('axios')

function isGhanaNumber(phone) {
  const cleaned = String(phone).replace(/\D/g, '')
  return cleaned.startsWith('233') || (cleaned.startsWith('0') && cleaned.length === 10)
}

function normalizeNumber(phone) {
  const cleaned = String(phone).replace(/[\s\-\(\)\+]/g, '')
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    return '233' + cleaned.substring(1)
  }
  return cleaned
}

function isGsm7String(text) {
  const gsm7Chars =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1BÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà\f^{}\\[~]|€"
  for (let i = 0; i < text.length; i++) {
    if (!gsm7Chars.includes(text[i])) return false;
  }
  return true
}

function calculateSMSUnits(message) {
  if (!message || message.length === 0) return 1
  const isGsm = isGsm7String(message)
  const len = message.length
  if (isGsm) {
    if (len <= 160) return 1
    return Math.ceil(len / 153)
  } else {
    if (len <= 70) return 1
    return Math.ceil(len / 67)
  }
}

async function sendSMS({ to, message, senderId = 'TXTORA' }) {
  const apiKey = process.env.ARKESEL_API_KEY
  const recipients = Array.isArray(to) ? to.map(normalizeNumber) : [normalizeNumber(to)]

  // Only mock when running the automated test runner (NODE_ENV=test).
  if (process.env.NODE_ENV === 'test') {
    console.log(`[SMS TEST MOCK] To: ${recipients.join(', ')} | From: ${senderId} | Msg: "${message}"`)
    return {
      status: 'success',
      code: '1000',
      message: 'Successfully sent (Simulated in Test Suite)',
      data: { recipients_count: recipients.length }
    }
  }

  // Fail closed: never report a fake success (and let the caller refund) if the carrier key is missing.
  if (!apiKey) {
    throw new Error('SMS gateway is not configured (ARKESEL_API_KEY missing). Message was not sent.')
  }

  try {
    const endpoint = 'https://sms.arkesel.com/api/v2/sms/send'
    const response = await axios.post(
      endpoint,
      {
        sender: senderId,
        message,
        recipients
      },
      {
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    )

    return response.data
  } catch (err) {
    // If v2 fails or returns provider error, fallback to Arkesel v1 API
    try {
      const v1Response = await axios.get('https://sms.arkesel.com/sms/api', {
        params: {
          action: 'send-sms',
          api_key: apiKey,
          to: recipients.join(','),
          from: senderId,
          sms: message,
          response: 'json'
        },
        timeout: 15000
      })
      return v1Response.data
    } catch (v1Err) {
      const providerError = err.response?.data || v1Err.response?.data || { message: err.message }
      console.error('[ARKESEL GATEWAY ERROR]', providerError)
      throw new Error(providerError.message || JSON.stringify(providerError))
    }
  }
}

module.exports = {
  isGhanaNumber,
  normalizeNumber,
  calculateSMSUnits,
  sendSMS
}
