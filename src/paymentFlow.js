const {
  calculateSMSPrice,
  calculateSMSProfit,
  calculateTotalSMSUnits,
  calculateSMSUnits,
  detectEncoding
} = require('./pricing')
const { COST_PER_SMS, SELLING_PRICE_PER_SMS } = require('./config')

function createPaymentFlow({
  alertDeveloper,
  bot,
  checkArkeselBalance,
  customSenderIdFeeGHS,
  forgetPaymentSession = reference => {
    delete paymentSessions[reference]
  },
  genericSenderId,
  initializePayment,
  paymentSessions,
  recordDeliveryResult = async () => {},
  rememberPaymentSession = (reference, session) => {
    paymentSessions[reference] = session
  },
  requestManualSenderIdApproval,
  rememberPendingSenderIdSession,
  sendSMS,
  userSessions,
  verifyPayment
}) {

  const fulfilledPayments =
    new Set()

  function smsResultCode(result) {
    if (typeof result === 'string' || typeof result === 'number') {
      return String(result).trim().toLowerCase()
    }

    return String(result?.code || result?.status || '')
      .trim()
      .toLowerCase()
  }

  function paymentAmountMatches(payment, session) {

    const expectedAmount =
      Math.round(Number(session.price) * 100)

    return payment.currency === 'GHS' && payment.amount === expectedAmount
  }

  async function notifyPaymentMismatch(reference, session, label) {

    console.log(
      'PAYMENT AMOUNT MISMATCH:',
      {
        reference,
        expectedAmount: Math.round(Number(session.price) * 100),
        paymentAmount: session.paymentAmount,
        paymentCurrency: session.paymentCurrency
      }
    )

    await bot.telegram.sendMessage(
      session.chatId,
      `❌ Payment verification failed.

The paid amount does not match this ${label}.

Reference:
${reference}`
    )
  }

  async function requestSenderIdApprovalAfterFee(reference, session) {

    fulfilledPayments.add(reference)
    forgetPaymentSession(reference)

    session.senderIdFeePaid = true
    session.senderVerificationStatus = 'pending'
    session.step = 'waiting_for_sender_verification'
    userSessions[session.userId] = session

    await bot.telegram.sendMessage(
      session.chatId,
      `✅ Sender ID fee paid.

Sender ID:
${session.senderId}

Textora admin will now create/verify it in Textora. This can take some time.

You can come back later and check this chat. Your final SMS checkout will be created here after approval.`
    )

    const result =
      await requestManualSenderIdApproval(session)

    session.senderVerificationRequestId =
      result.requestId

    if (result.status === 'failed') {
      session.step = 'waiting_for_sender_choice'
      return bot.telegram.sendMessage(
        session.chatId,
        'Sender ID approval request failed.\n\n' +
        'Message:\n' +
        (result.message || 'Please try another sender ID or use the free sender ID.')
      )
    }

    rememberPendingSenderIdSession(result.requestId, session)

    return bot.telegram.sendMessage(
      session.chatId,
      `Sender ID request submitted.

Status:
Pending manual Textora verification`
    )
  }

  async function sendBulkSMSForPayment(reference) {

    if (fulfilledPayments.has(reference)) {
      return
    }

    const session =
      paymentSessions[reference]

    if (!session) {
      console.log('PAYMENT SESSION NOT FOUND:', reference)
      return
    }

    const payment =
      await verifyPayment(reference)

    if (payment?.status !== 'success') {

      await bot.telegram.sendMessage(
        session.chatId,
        `❌ Payment not completed.

Status:
${payment?.status || 'unknown'}

Message:
${payment?.gateway_response || payment?.message || 'Please try again.'}`
      )

      return
    }

    if (!paymentAmountMatches(payment, session)) {
      session.paymentAmount = payment.amount
      session.paymentCurrency = payment.currency
      await notifyPaymentMismatch(reference, session, 'SMS order')
      return
    }

    const requiredCredits =
      calculateTotalSMSUnits(
        session.contacts.length,
        session.smsUnits
      )

    if (session.senderIdType === 'generic' && genericSenderId) {
      session.senderId = genericSenderId
      rememberPaymentSession(reference, session)
    }

    const arkeselBalance =
      await checkArkeselBalance()

    if (arkeselBalance === null || arkeselBalance < requiredCredits) {

      const alertMessage =
        `LOW ARKESEL SMS CREDIT ALERT

Payment was confirmed, but SMS was not sent.

Reference: ${reference}
Customer chat: ${session.chatId}
Contacts: ${session.contacts.length}
SMS units: ${session.smsUnits}
Required credits: ${requiredCredits}
Available credits: ${arkeselBalance === null ? 'unknown' : arkeselBalance}
Amount paid: GHS ${session.price}`

      await alertDeveloper(alertMessage)

      await bot.telegram.sendMessage(
        session.chatId,
        `✅ Payment confirmed.

Your SMS is pending because the sender account needs more SMS credit.

Reference:
${reference}`
      )

      return
    }

    let sentCount = 0
    let failedCount = 0
    let failureReason = null
    let shouldRetryAfterCreditRefill = false
    let shouldRetryAfterSenderIdFix = false
    const originalContactCount =
      session.contacts.length

    let runningArkeselBalance = arkeselBalance !== null ? arkeselBalance : 0

    for (const [index, number] of session.contacts.entries()) {

      const result =
        await sendSMS(number, session.message, session.senderId)
      const code =
        smsResultCode(result)

      const msgUnits = calculateSMSUnits(session.message)
      const wallet_before = runningArkeselBalance
      const wallet_after = runningArkeselBalance - msgUnits
      runningArkeselBalance = wallet_after

      const msgId = result?.id || result?.message_id || `msg_${reference}_${index}`
      const userCharge = (msgUnits * SELLING_PRICE_PER_SMS).toFixed(2)
      const providerCost = (msgUnits * COST_PER_SMS).toFixed(4)

      console.log(JSON.stringify({
        message_id: String(msgId),
        recipient: number,
        raw_message: session.message,
        character_count: session.message.length,
        detected_encoding: detectEncoding(session.message),
        calculated_segments: msgUnits,
        user_charge: userCharge,
        arkesel_charge: providerCost,
        wallet_before: wallet_before.toFixed(2),
        wallet_after: wallet_after.toFixed(2),
        deducted_amount: msgUnits.toFixed(2),
        timestamp: new Date().toISOString()
      }))

      if (code === 'ok' || code === '1000' || code === 'success') {
        sentCount += 1
      } else if (code === '105') {
        shouldRetryAfterCreditRefill = true
        session.contacts =
          session.contacts.slice(index)
        session.deliveredContacts =
          (session.deliveredContacts || 0) + sentCount
        session.failedContacts =
          session.failedContacts || 0
        session.billedSMS =
          session.deliveredContacts * session.smsUnits
        session.profit =
          calculateSMSProfit(session.deliveredContacts, session.smsUnits)
        session.step =
          'waiting_for_arkesel_credit_refill'

        await alertDeveloper(
          `ARKESEL CREDIT RAN OUT WHILE SENDING
 
Reference: ${reference}
Failed recipient: ${number}
Sent so far: ${sentCount}/${originalContactCount}`
        )
        failureReason = 'Textora SMS credit ran out while sending.'
        break
      } else if (code === '106') {
        shouldRetryAfterSenderIdFix = true
        session.contacts =
          session.contacts.slice(index)
        session.deliveredContacts =
          (session.deliveredContacts || 0) + sentCount
        session.failedContacts =
          session.failedContacts || 0
        session.billedSMS =
          session.deliveredContacts * session.smsUnits
        session.profit =
          calculateSMSProfit(session.deliveredContacts, session.smsUnits)
        session.step =
          'waiting_for_sender_id_fix'

        await alertDeveloper(
          `ARKESEL REJECTED SENDER ID
 
Reference: ${reference}
Sender ID: ${session.senderId}
Failed recipient: ${number}`
        )
        failureReason = 'Textora rejected the sender ID.'
        break
      } else {
        failedCount += 1
      }
    }

    if (shouldRetryAfterCreditRefill) {
      userSessions[session.userId] = session
      rememberPaymentSession(reference, session)
      await recordDeliveryResult(session)

      await bot.telegram.sendMessage(
        session.chatId,
        `✅ Payment confirmed.

Sender ID:
${session.senderId}

SMS sent to ${session.deliveredContacts} contacts so far.

${failureReason}
Textora support has been notified. The remaining paid messages will continue after SMS credit is refilled.`
      )

      return
    }

    if (shouldRetryAfterSenderIdFix) {
      userSessions[session.userId] = session
      rememberPaymentSession(reference, session)
      await recordDeliveryResult(session)

      await bot.telegram.sendMessage(
        session.chatId,
        `✅ Payment confirmed.

Sender ID:
${session.senderId}

SMS sent to ${session.deliveredContacts} contacts so far.

${failureReason}
Textora support has been notified. The remaining paid messages can be retried after the sender ID is fixed.`
      )

      return
    }

    session.deliveredContacts =
      (session.deliveredContacts || 0) + sentCount
    session.failedContacts =
      (session.failedContacts || 0) + failedCount
    session.billedSMS =
      session.deliveredContacts * session.smsUnits
    session.profit =
      calculateSMSProfit(session.deliveredContacts, session.smsUnits)

    fulfilledPayments.add(reference)
    await recordDeliveryResult(session)
    delete userSessions[session.userId]
    forgetPaymentSession(reference)

    await bot.telegram.sendMessage(
      session.chatId,
      `✅ Payment confirmed.

Sender ID:
${session.senderId}

SMS sent to ${session.deliveredContacts}/${session.deliveredContacts + session.failedContacts} contacts.${
  failureReason ? `\n\n${failureReason}\nTextora support has been notified.` : ''
}`
    )
  }

  async function processPaystackPayment(reference) {

    if (fulfilledPayments.has(reference)) {
      return
    }

    const session =
      paymentSessions[reference]

    if (!session) {
      console.log('PAYMENT SESSION NOT FOUND:', reference)
      return
    }

    const payment =
      await verifyPayment(reference)

    if (payment?.status !== 'success') {

      await bot.telegram.sendMessage(
        session.chatId,
        `❌ Payment not completed.

Status:
${payment?.status || 'unknown'}

Message:
${payment?.gateway_response || payment?.message || 'Please try again.'}`
      )

      return
    }

    if (!paymentAmountMatches(payment, session)) {
      session.paymentAmount = payment.amount
      session.paymentCurrency = payment.currency
      await notifyPaymentMismatch(
        reference,
        session,
        session.paymentPurpose === 'sender_id_fee'
          ? 'sender ID fee'
          : 'SMS order'
      )
      return
    }

    if (session.paymentPurpose === 'sender_id_fee') {
      return requestSenderIdApprovalAfterFee(reference, session)
    }

    return sendBulkSMSForPayment(reference)
  }

  async function createCheckout(ctx, userId, session) {

    session.smsPrice =
      calculateSMSPrice(
        session.contacts.length,
        session.smsUnits
      )

    session.price =
      session.smsPrice

    session.totalSMSUnits =
      calculateTotalSMSUnits(
        session.contacts.length,
        session.smsUnits
      )

    session.profit =
      calculateSMSProfit(
        session.contacts.length,
        session.smsUnits
      )

    session.senderIdFee = 0
    session.paymentPurpose = 'textora_bulk_sms'
    session.step = 'waiting_for_payment'

    await ctx.reply(`
📊 SMS SUMMARY

👥 Contacts:
${session.contacts.length}

📨 SMS Units:
${session.smsUnits}

Total SMS Units:
${session.totalSMSUnits}

Sender ID:
${session.senderId}

SMS Cost:
₵${session.smsPrice}

💵 Total SMS Cost:
₵${session.price}

⏳ Creating Paystack checkout...
  `)

    try {

      const payment =
        await initializePayment(userId, session)

      if (!payment?.authorization_url || !payment?.reference) {
        throw new Error('Paystack did not return a checkout URL.')
      }

      session.paymentReference =
        payment.reference

      rememberPaymentSession(payment.reference, {
        ...session,
        paymentReference: payment.reference
      })

      return ctx.reply(
        'Paystack checkout is ready.\n\n' +
        'Open the payment page, enter your MoMo details inside Paystack, and approve the transaction.\n\n' +
        'If Telecel/Vodafone keeps loading or returns to the number screen, open the payment page in Safari or Chrome and try again.\n\n' +
        'Reference:\n' +
        payment.reference,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Pay with Paystack',
                  url: payment.authorization_url
                }
              ],
              [
                {
                  text: "I've paid",
                  callback_data: 'check_payment_' + payment.reference
                }
              ]
            ]
          }
        }
      )

    } catch (err) {

      session.step =
        'waiting_for_sender_choice'

      return ctx.reply(
        'Failed to create Paystack checkout.\n\n' +
        'Paystack message:\n' +
        (err.response?.data?.message || err.message)
      )
    }
  }

  async function createSenderIdFeeCheckout(ctx, userId, session) {

    session.price =
      Number(customSenderIdFeeGHS).toFixed(2)

    session.senderIdFee =
      customSenderIdFeeGHS

    session.paymentPurpose =
      'sender_id_fee'

    session.step =
      'waiting_for_sender_id_fee_payment'

    await ctx.reply(`
Custom sender ID fee:
₵${session.price}

Sender ID:
${session.senderId}

This checkout is only for the one-time sender ID fee. The SMS checkout will be created after Textora admin approves the sender ID.

⏳ Creating Paystack checkout...
  `)

    try {

      const payment =
        await initializePayment(userId, session)

      if (!payment?.authorization_url || !payment?.reference) {
        throw new Error('Paystack did not return a checkout URL.')
      }

      session.senderIdFeePaymentReference =
        payment.reference

      rememberPaymentSession(payment.reference, {
        ...session,
        senderIdFeePaymentReference: payment.reference
      })

      return ctx.reply(
        'Sender ID fee checkout is ready.\n\n' +
        'Pay the one-time sender ID fee first. Textora admin will receive the approval request only after this fee is confirmed.\n\n' +
        'Reference:\n' +
        payment.reference,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Pay sender ID fee',
                  url: payment.authorization_url
                }
              ],
              [
                {
                  text: "I've paid",
                  callback_data: 'check_payment_' + payment.reference
                }
              ]
            ]
          }
        }
      )

    } catch (err) {

      session.step =
        'confirming_custom_sender_id'

      return ctx.reply(
        'Failed to create sender ID fee checkout.\n\n' +
        'Paystack message:\n' +
        (err.response?.data?.message || err.message)
      )
    }
  }

  return {
    createCheckout,
    createSenderIdFeeCheckout,
    processPaystackPayment
  }
}

module.exports = {
  createPaymentFlow
}
