const {
  calculateSMSPrice,
  calculateSMSProfit,
  calculateTotalSMSUnits,
  calculateSMSUnits,
  detectEncoding,
  isGhanaNumber
} = require('./pricing')
const { COST_PER_SMS, SELLING_PRICE_PER_SMS } = require('./config')
const { withLock } = require('./lockManager')
const {
  getSmsLogStatus,
  reserveSmsLog,
  markSmsLogSent,
  markSmsLogFailed
} = require('./stores/smsLogger')

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

  // Helper functions for reading/modifying payment sessions with fallback support for in-memory object (tests)
  const getSession = async (reference) => {
    if (typeof paymentSessions.getSession === 'function') {
      return await paymentSessions.getSession(reference)
    }
    return paymentSessions[reference] || null
  }

  const updateSession = async (reference, updateFn) => {
    if (typeof paymentSessions.updateSession === 'function') {
      await paymentSessions.updateSession(reference, updateFn)
    } else {
      const session = paymentSessions[reference]
      if (session) {
        const res = await updateFn(session)
        if (res !== undefined) {
          paymentSessions[reference] = res
        }
      }
    }
  }

  const forgetSession = async (reference) => {
    if (typeof paymentSessions.forgetSession === 'function') {
      await paymentSessions.forgetSession(reference)
    } else {
      delete paymentSessions[reference]
    }
    forgetPaymentSession(reference)
  }

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
    await forgetSession(reference)

    session.senderIdFeePaid = true
    session.senderVerificationStatus = 'pending'
    session.step = 'waiting_for_sender_verification'
    userSessions[session.userId] = session

    await bot.telegram.sendMessage(
      session.chatId,
      `${Number(session.senderIdFee) > 0 ? '✅ Sender ID fee paid.' : '✅ Sender ID request received (free).'}

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

  async function requestApiRechargeApproval(reference, session) {
    fulfilledPayments.add(reference)

    await updateSession(reference, s => {
      s.status = 'waiting_for_admin_approval'
      return s
    })

    const developerChatId = process.env.DEVELOPER_CHAT_ID

    if (!developerChatId) {
      console.log(`API Recharge Approval needed for ref ${reference}, but DEVELOPER_CHAT_ID is not configured.`)
      return
    }

    try {
      await bot.telegram.sendMessage(
        developerChatId,
        `🔔 *NEW API RECHARGE PAYMENT* 🔔\n\n` +
        `👤 *Developer ID:* \`${session.userId}\`\n` +
        `💰 *Amount Paid:* ₵${session.price}\n` +
        `📨 *SMS Credits requested:* ${session.credits} units\n` +
        `🔑 *Reference:* \`${reference}\`\n\n` +
        `*Action Required:*\n` +
        `1. Please top up your Arkesel account with at least *${session.credits}* credits.\n` +
        `2. Once topped up, click *Approve Recharge* below to fund the developer's prepaid balance.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Approve Recharge', callback_data: `approve_recharge_${reference}` }],
              [{ text: '❌ Reject Recharge', callback_data: `reject_recharge_${reference}` }]
            ]
          }
        }
      )

      await bot.telegram.sendMessage(
        session.chatId,
        `✅ *Payment Verified Successfully!*\n\n` +
        `Amount: ₵${session.price}\n` +
        `Credits: ${session.credits} units\n\n` +
        `The bot owner has been notified to top up the SMS gateway. Your API balance will be updated once they approve. Thank you!`
      )
    } catch (err) {
      console.log('API RECHARGE APPROVAL ALERT ERROR:', err.message)
    }
  }

  async function sendBulkSMSForPayment(reference) {

    if (fulfilledPayments.has(reference)) {
      return
    }

    const session = await getSession(reference)

    if (!session) {
      console.log('PAYMENT SESSION NOT FOUND:', reference)
      return
    }

    const requiredCredits =
      calculateTotalSMSUnits(
        session.contacts.length,
        session.smsUnits
      )

    if (session.senderIdType === 'generic' && genericSenderId) {
      session.senderId = genericSenderId
      await updateSession(reference, s => {
        s.senderId = genericSenderId
        return s
      })
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

      await updateSession(reference, s => {
        s.step = 'waiting_for_arkesel_credit_refill'
        return s
      })
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
      // 1. Check SMS log for duplicate
      const logEntry = await getSmsLogStatus(reference, number)

      if (logEntry) {
        if (logEntry.status === 'sent') {
          console.log(`SMS already sent to ${number} for ${reference}. Skipping.`)
          sentCount += 1
          continue
        }
        if (logEntry.status === 'reserved') {
          const isFresh = (Date.now() - logEntry.timestamp) < 120000
          if (isFresh) {
            console.log(`SMS already reserved/sending to ${number} for ${reference}. Skipping.`)
            sentCount += 1
            continue
          }
        }
      }

      // 2. Reserve SMS before sending
      await reserveSmsLog(reference, number)

      let result
      try {
        result = await sendSMS(number, session.message, session.senderId)
      } catch (err) {
        result = { code: 'failed', message: err.message }
      }

      const code = smsResultCode(result)

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
        await markSmsLogSent(reference, number)
        sentCount += 1
      } else if (code === '105') {
        await markSmsLogFailed(reference, number)
        shouldRetryAfterCreditRefill = true
        
        await updateSession(reference, s => {
          s.contacts = s.contacts.slice(index)
          s.deliveredContacts = (s.deliveredContacts || 0) + sentCount
          s.failedContacts = s.failedContacts || 0
          s.billedSMS = s.deliveredContacts * s.smsUnits
          s.profit = calculateSMSProfit(s.deliveredContacts, s.smsUnits)
          s.step = 'waiting_for_arkesel_credit_refill'
          return s
        })

        await alertDeveloper(
          `ARKESEL CREDIT RAN OUT WHILE SENDING
 
Reference: ${reference}
Failed recipient: ${number}
Sent so far: ${sentCount}/${originalContactCount}`
        )
        failureReason = 'Textora SMS credit ran out while sending.'
        break
      } else if (code === '106') {
        await markSmsLogFailed(reference, number)
        shouldRetryAfterSenderIdFix = true
        
        await updateSession(reference, s => {
          s.contacts = s.contacts.slice(index)
          s.deliveredContacts = (s.deliveredContacts || 0) + sentCount
          s.failedContacts = s.failedContacts || 0
          s.billedSMS = s.deliveredContacts * s.smsUnits
          s.profit = calculateSMSProfit(s.deliveredContacts, s.smsUnits)
          s.step = 'waiting_for_sender_id_fix'
          return s
        })

        await alertDeveloper(
          `ARKESEL REJECTED SENDER ID
 
Reference: ${reference}
Sender ID: ${session.senderId}
Failed recipient: ${number}`
        )
        failureReason = 'Textora rejected the sender ID.'
        break
      } else {
        await markSmsLogFailed(reference, number)
        failedCount += 1
      }
    }

    const currentSession = await getSession(reference)

    if (shouldRetryAfterCreditRefill) {
      userSessions[currentSession.userId] = currentSession
      await recordDeliveryResult(currentSession)

      await bot.telegram.sendMessage(
        currentSession.chatId,
        `✅ Payment confirmed.

Sender ID:
${currentSession.senderId}

SMS sent to ${currentSession.deliveredContacts} contacts so far.

${failureReason}
Textora support has been notified. The remaining paid messages will continue after SMS credit is refilled.`
      )

      return
    }

    if (shouldRetryAfterSenderIdFix) {
      userSessions[currentSession.userId] = currentSession
      await recordDeliveryResult(currentSession)

      await bot.telegram.sendMessage(
        currentSession.chatId,
        `✅ Payment confirmed.

Sender ID:
${currentSession.senderId}

SMS sent to ${currentSession.deliveredContacts} contacts so far.

${failureReason}
Textora support has been notified. The remaining paid messages can be retried after the sender ID is fixed.`
      )

      return
    }

    await updateSession(reference, s => {
      s.deliveredContacts = (s.deliveredContacts || 0) + sentCount
      s.failedContacts = (s.failedContacts || 0) + failedCount
      s.billedSMS = s.deliveredContacts * s.smsUnits
      s.profit = calculateSMSProfit(s.deliveredContacts, s.smsUnits)
      return s
    })

    const finalSession = await getSession(reference)
    fulfilledPayments.add(reference)
    await recordDeliveryResult(finalSession)
    delete userSessions[finalSession.userId]
    await forgetSession(reference)

    await bot.telegram.sendMessage(
      finalSession.chatId,
      `✅ Payment confirmed.

Sender ID:
${finalSession.senderId}

SMS sent to ${finalSession.deliveredContacts}/${finalSession.deliveredContacts + finalSession.failedContacts} contacts.${
  failureReason ? `\n\n${failureReason}\nTextora support has been notified.` : ''
}`
    )
  }

  async function processPaystackPayment(reference, options = {}) {
    const { isManualResume = false, isBypassVerification = false } = options

    if (fulfilledPayments.has(reference)) {
      return
    }

    // STEP 1 — Claim Phase (Inside Transaction Lock)
    let session = null
    const eligible = await withLock(`tx_${reference}`, async () => {
      session = await getSession(reference)
      if (!session) {
        console.log('PAYMENT SESSION NOT FOUND:', reference)
        return false
      }

      // Read status from state machine
      const status = session.status || 'pending'

      if (isManualResume) {
        // Allow paused or pending status for manual resume
        if (status !== 'paused' && status !== 'pending') {
          console.log(`Manual resume skipped: Transaction status is ${status}, expected paused or pending.`)
          return false
        }
      } else {
        // Webhooks and standard button clicks must only process pending
        if (status !== 'pending') {
          console.log(`Auto-process skipped: Transaction status is ${status}, expected pending.`)
          return false
        }
      }

      // Transition to processing
      await updateSession(reference, s => {
        s.status = 'processing'
        s.processingTimestamp = Date.now()
        return s
      })
      return true
    })

    if (!eligible) {
      return
    }

    // Refresh local variable with processing status
    session = await getSession(reference)

    // STEP 2 — Execution Phase (No Lock)
    let executionError = null
    try {
      let payment
      if (isBypassVerification) {
        payment = {
          status: 'success',
          amount: Math.round(Number(session.price) * 100),
          currency: 'GHS'
        }
      } else {
        payment = await verifyPayment(reference)
      }

      if (payment?.status !== 'success') {
        await bot.telegram.sendMessage(
          session.chatId,
          `❌ Payment not completed.

Status:
${payment?.status || 'unknown'}

Message:
${payment?.gateway_response || payment?.message || 'Please try again.'}`
        )
        throw new Error(`Paystack verification failed with status: ${payment?.status}`)
      }

      if (!paymentAmountMatches(payment, session)) {
        session.paymentAmount = payment.amount
        session.paymentCurrency = payment.currency
        await notifyPaymentMismatch(
          reference,
          session,
          session.paymentPurpose === 'sender_id_fee'
            ? 'sender ID fee'
            : (session.paymentPurpose === 'textora_api_recharge' ? 'API recharge' : 'SMS order')
        )
        throw new Error('Payment amount mismatch')
      }

      if (session.paymentPurpose === 'sender_id_fee') {
        await requestSenderIdApprovalAfterFee(reference, session)
      } else if (session.paymentPurpose === 'textora_api_recharge') {
        await requestApiRechargeApproval(reference, session)
      } else {
        await sendBulkSMSForPayment(reference)
      }
    } catch (err) {
      executionError = err
    }

    // STEP 3 — Final Commit Phase (Re-lock)
    await withLock(`tx_${reference}`, async () => {
      const currentSession = await getSession(reference)
      if (!currentSession) {
        // If it was already completed and deleted, do nothing
        return
      }

      // Verify that no other process has tampered with the status
      if (currentSession.status !== 'processing') {
        console.log(`Duplicate commit avoided. Status is ${currentSession.status}`)
        return
      }

      if (executionError) {
        const isRefill = currentSession.step === 'waiting_for_arkesel_credit_refill'
        const isSenderFix = currentSession.step === 'waiting_for_sender_id_fix'

        const nextStatus = (isRefill || isSenderFix) ? 'paused' : 'failed'
        await updateSession(reference, s => {
          s.status = nextStatus
          return s
        })
      } else {
        // If not deleted already, set it to sent
        const isRefill = currentSession.step === 'waiting_for_arkesel_credit_refill'
        const isSenderFix = currentSession.step === 'waiting_for_sender_id_fix'

        if (isRefill || isSenderFix) {
          await updateSession(reference, s => {
            s.status = 'paused'
            return s
          })
        } else {
          // Final immutable state
          await updateSession(reference, s => {
            s.status = 'sent'
            return s
          })
        }
      }
    })
  }

  async function createCheckout(ctx, userId, session) {

    session.smsPrice =
      calculateSMSPrice(
        session.contacts,
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
        session.contacts,
        session.smsUnits
      )

    session.senderIdFee = 0
    session.paymentPurpose = 'textora_bulk_sms'
    session.step = 'waiting_for_payment'
    session.status = 'pending'

    const localCount = session.contacts.filter(isGhanaNumber).length
    const internationalCount = session.contacts.length - localCount

    await ctx.reply(`
📊 SMS SUMMARY

👥 Total Contacts: ${session.contacts.length}
  🇬🇭 Ghana: ${localCount}
  🌍 International: ${internationalCount}

📨 SMS Units: ${session.smsUnits}
Total SMS Units: ${session.totalSMSUnits}

Sender ID: ${session.senderId}

💵 Total SMS Cost: ₵${session.price}

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

      await rememberPaymentSession(payment.reference, {
        ...session,
        paymentReference: payment.reference,
        status: 'pending'
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

    // Free sender IDs: skip Paystack and go straight to admin approval.
    if (!(Number(customSenderIdFeeGHS) > 0)) {
      session.senderIdFee = 0
      session.price = '0.00'
      session.paymentPurpose = 'sender_id_fee'
      return requestSenderIdApprovalAfterFee('free_sid_' + userId + '_' + Date.now(), session)
    }

    session.price =
      Number(customSenderIdFeeGHS).toFixed(2)

    session.senderIdFee =
      customSenderIdFeeGHS

    session.paymentPurpose =
      'sender_id_fee'

    session.step =
      'waiting_for_sender_id_fee_payment'
    session.status = 'pending'

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

      await rememberPaymentSession(payment.reference, {
        ...session,
        senderIdFeePaymentReference: payment.reference,
        status: 'pending'
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
