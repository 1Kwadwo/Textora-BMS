function createArkeselService({ axios, apiKey, genericSenderId }) {

  async function sendSMS(number, message, senderId = genericSenderId) {

    const from =
      String(senderId || '').trim()

    if (!from) {
      const result =
        {
          code: 'missing_sender_id',
          message: 'Missing SMS sender ID.'
        }

      console.log('SMS ERROR:', result.message)

      return result
    }

    // 1. Primary: Arkesel v2 POST API (robust handling for long multi-unit SMS, emojis, and Unicode)
    try {
      const response = await axios.post(
        'https://sms.arkesel.com/api/v2/sms/send',
        {
          sender: from,
          message,
          recipients: [number]
        },
        {
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      )

      console.log('SMS RESPONSE (v2):', response.data)

      return response.data

    } catch (err) {
      console.log('SMS v2 ERROR:', err.response?.data || err.message)

      // 2. Fallback: Arkesel v1 GET API
      try {
        const response = await axios.get(
          'https://sms.arkesel.com/sms/api',
          {
            params: {
              action: 'send-sms',
              api_key: apiKey,
              to: number,
              from,
              sms: message,
              response: 'json'
            },
            timeout: 15000
          }
        )

        console.log('SMS RESPONSE (v1):', response.data)

        return response.data

      } catch (v1Err) {
        console.log(
          'SMS v1 ERROR:',
          v1Err.response?.data || v1Err.message
        )

        return v1Err.response?.data || err.response?.data || { code: 'failed', message: err.message }
      }
    }
  }

  async function checkArkeselBalance() {

    try {

      const response = await axios.get(
        'https://sms.arkesel.com/sms/api',
        {
          params: {
            action: 'check-balance',
            api_key: apiKey,
            response: 'json'
          },
          timeout: 15000
        }
      )

      console.log('ARKESEL BALANCE RESPONSE:', response.data)

      const balance =
        Number(response.data?.balance)

      return Number.isFinite(balance)
        ? balance
        : null

    } catch (err) {

      console.log(
        'ARKESEL BALANCE ERROR:',
        err.response?.data || err.message
      )

      return null
    }
  }

  return {
    checkArkeselBalance,
    sendSMS
  }
}

module.exports = {
  createArkeselService
}
