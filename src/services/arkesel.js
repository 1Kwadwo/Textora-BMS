function createArkeselService({ axios, apiKey, genericSenderId }) {

  async function sendSMS(number, message, senderId = genericSenderId) {

    try {

      const url =
        `https://sms.arkesel.com/sms/api` +
        `?action=send-sms` +
        `&api_key=${apiKey}` +
        `&to=${number}` +
        `&from=${encodeURIComponent(senderId)}` +
        `&sms=${encodeURIComponent(message)}`

      const response = await axios.get(url)

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
