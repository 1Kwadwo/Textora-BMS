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
          }
        }
      )

      console.log('SMS RESPONSE:', response.data)

      return response.data

    } catch (err) {

      console.log(
        'SMS ERROR:',
        err.response?.data || err.message
      )

      return null
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
          }
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
