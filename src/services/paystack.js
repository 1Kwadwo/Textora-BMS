function createPaystackService({ axios, secretKey, callbackUrl }) {

  async function initializePayment(userId, session) {

    try {

      const payload = {
        email: `${userId}@textora.app`,
        amount: Math.round(Number(session.price) * 100),
        currency: 'GHS',
        channels: ['mobile_money'],
        metadata: {
          service: session.paymentPurpose || 'textora_bulk_sms',
          telegram_user_id: String(userId),
          telegram_chat_id: String(session.chatId),
          contact_count: session.contacts?.length || 0,
          sms_units: session.smsUnits || 0,
          sender_id: session.senderId,
          sender_id_type: session.senderIdType,
          sender_id_fee: session.senderIdFee || 0
        }
      }

      if (callbackUrl) {
        payload.callback_url = callbackUrl
      }

      const response = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        payload,
        {
          headers: {
            Authorization:
              `Bearer ${secretKey}`,

            'Content-Type':
              'application/json'
          }
        }
      )

      console.log(
        'PAYSTACK INIT RESPONSE:',
        response.data
      )

      return response.data?.data

    } catch (err) {

      console.log(
        'PAYSTACK INIT ERROR:',
        err.response?.data || err.message
      )

      throw err
    }
  }

  async function verifyPayment(reference) {

    try {

      const response = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: {
            Authorization:
              `Bearer ${secretKey}`
          }
        }
      )

      console.log(
        'PAYSTACK VERIFY RESPONSE:',
        response.data
      )

      return response.data?.data

    } catch (err) {

      console.log(
        'PAYSTACK VERIFY ERROR:',
        err.response?.data || err.message
      )

      return null
    }
  }

  return {
    initializePayment,
    verifyPayment
  }
}

module.exports = {
  createPaystackService
}
