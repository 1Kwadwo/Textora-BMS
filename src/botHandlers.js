const { extractContactsFromFile, validateContactsFromText } = require('./contacts')
const { calculateSMSUnits } = require('./pricing')
const { buildSenderIdKeyboard, validateSenderId } = require('./senderIds')
const {
  answerCallback,
  downloadTelegramFile,
  isDeveloperApprovalContext
} = require('./services/telegram')

function registerBotHandlers({
  axios,
  bot,
  createCheckout,
  createSenderIdFeeCheckout,
  customSenderIdFeeGHS,
  forgetPendingSenderIdSession,
  genericSenderId,
  getVerifiedSenderIds,
  paymentProcessor,
  pendingSenderIdSessions,
  rememberVerifiedSenderId,
  userSessions
}) {

  function senderIdKeyboard(userId) {

    return buildSenderIdKeyboard({
      customSenderIdFeeGHS,
      genericSenderId,
      getVerifiedSenderIds,
      userId
    })
  }

  function clearCustomSenderIdDetails(session) {

    delete session.senderId
    delete session.senderIdType
    delete session.senderIdFee
    delete session.senderIdFeePaid
    delete session.paymentPurpose
    delete session.senderVerificationStatus
    delete session.senderVerificationRequestId
    delete session.senderIdContactNumber
    delete session.senderIdUseCase
  }

  async function acceptContacts(ctx, session, contactResult) {

    if (contactResult.contacts.length === 0) {

      return ctx.reply(`
❌ No valid numbers found.

You can paste contacts or upload a .xlsx, .csv, .tsv, or .txt file.

Accepted formats include:
233541234567
0541234567
+233541234567
    `)
    }

    session.contacts =
      contactResult.contacts

    session.contactValidation =
      {
        totalCandidates: contactResult.totalCandidates,
        duplicatesRemoved: contactResult.duplicates.length,
        invalidSkipped: contactResult.invalid.length
      }

    session.step =
      'waiting_for_message'

    return ctx.reply(`
✅ ${contactResult.contacts.length} valid unique contacts uploaded.

Duplicates removed:
${contactResult.duplicates.length}

Invalid entries skipped:
${contactResult.invalid.length}

Now type the SMS message you want to send.
  `)
  }

  bot.start((ctx) => {

    ctx.reply(
      `🚀 Welcome to Textora SMS

Choose an option below:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📨 Send Bulk SMS',
                callback_data: 'send_bulk'
              }
            ],
            [
              {
                text: '📖 Help',
                callback_data: 'help'
              }
            ]
          ]
        }
      }
    )
  })

  bot.telegram.setMyCommands([
    {
      command: 'start',
      description: 'Open main menu'
    },
    {
      command: 'myid',
      description: 'Show your Telegram chat ID'
    }
  ])

  bot.action('help', async (ctx) => {

    await answerCallback(ctx)

    ctx.reply(`
📌 TEXTORA SMS COMMANDS

/start - Open Menu

📨 Bulk SMS Flow:
1. Paste contacts or upload .xlsx, .csv, .tsv, or .txt contacts
2. Type message
3. Choose free ${genericSenderId}, reuse an approved custom sender ID, or create a new one
4. New custom sender IDs cost ₵${customSenderIdFeeGHS.toFixed(2)} once before admin approval
5. After sender ID approval, pay only the SMS cost
6. SMS sends after Paystack confirms the SMS payment
  `)
  })

  bot.command('myid', async (ctx) => {

    return ctx.reply(
      `Your Telegram chat ID is:
${ctx.chat.id}`
    )
  })

  bot.action('send_bulk', async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id

    userSessions[userId] = {
      step: 'waiting_for_contacts',
      userId,
      chatId: ctx.chat.id
    }

    ctx.reply(`
📨 Send your contacts.

Paste contacts or upload a .xlsx, .csv, .tsv, or .txt file.

Accepted formats:
233541234567
0541234567
+233201234567
233201234567

Textora will validate Ghana numbers, convert them to 233 format, remove repeated numbers, and skip invalid entries.
  `)
  })

  bot.action(/^check_payment_(.+)$/, async (ctx) => {

    await answerCallback(ctx)

    const reference =
      ctx.match[1]

    await ctx.reply('⏳ Checking payment...')

    await paymentProcessor(reference)
  })

  bot.action('use_generic_sender_id', async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const session = userSessions[userId]

    if (!session || session.step !== 'waiting_for_sender_choice') {
      return ctx.reply('Start again with /start to send a new bulk SMS.')
    }

    session.senderId = genericSenderId
    session.senderIdType = 'generic'
    session.senderIdFee = 0
    session.senderVerificationStatus = 'verified'

    return createCheckout(ctx, userId, session)
  })

  bot.action(/^use_verified_sender_id_(\d+)$/, async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const session = userSessions[userId]
    const senderId =
      getVerifiedSenderIds(userId)[Number(ctx.match[1])]

    if (!session || session.step !== 'waiting_for_sender_choice' || !senderId) {
      return ctx.reply('Start again with /start to send a new bulk SMS.')
    }

    session.senderId = senderId
    session.senderIdType = 'verified_custom'
    session.senderIdFee = 0
    session.senderVerificationStatus = 'verified'

    return createCheckout(ctx, userId, session)
  })

  bot.action(/^approve_sender_(.+)$/, async (ctx) => {

    await answerCallback(ctx)

    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can approve sender IDs.')
    }

    const requestId =
      ctx.match[1]

    const session =
      pendingSenderIdSessions[requestId]

    if (!session) {
      return ctx.reply('Sender ID request was not found or has already been handled.')
    }

    forgetPendingSenderIdSession(requestId)

    session.senderVerificationStatus = 'verified'
    session.senderIdFee = 0
    session.paymentPurpose = 'textora_bulk_sms'
    userSessions[session.userId] = session
    rememberVerifiedSenderId(session.userId, session.senderId)

    await ctx.reply(
      `Approved sender ID ${session.senderId}. Textora is creating checkout for the customer.`
    )

    await bot.telegram.sendMessage(
      session.chatId,
      `✅ Sender ID verified.

Sender ID:
${session.senderId}

Creating your final checkout now...`
    )

    return createCheckout(
      {
        reply: (message, extra) => bot.telegram.sendMessage(session.chatId, message, extra)
      },
      session.userId,
      session
    )
  })

  bot.action(/^reject_sender_(.+)$/, async (ctx) => {

    await answerCallback(ctx)

    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can reject sender IDs.')
    }

    const requestId =
      ctx.match[1]

    const session =
      pendingSenderIdSessions[requestId]

    if (!session) {
      return ctx.reply('Sender ID request was not found or has already been handled.')
    }

    forgetPendingSenderIdSession(requestId)

    session.step = 'sender_id_rejected'
    session.rejectedRequestId = requestId
    userSessions[session.userId] = session

    await ctx.reply('Rejected sender ID request. The customer has been notified.')

    return bot.telegram.sendMessage(
      session.chatId,
      `❌ Sender ID was not verified.

You can request a refund for the sender ID fee or try another custom sender ID.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: 'Request refund',
                callback_data: `request_refund_${requestId}`
              }
            ],
            [
              {
                text: 'Try another sender ID',
                callback_data: 'try_another_sender_id'
              }
            ]
          ]
        }
      }
    )
  })

  bot.action('create_custom_sender_id', async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const session = userSessions[userId]

    if (!session || session.step !== 'waiting_for_sender_choice') {
      return ctx.reply('Start again with /start to send a new bulk SMS.')
    }

    session.step = 'waiting_for_custom_sender_id'

    return ctx.reply(`
Custom sender ID costs ₵${customSenderIdFeeGHS.toFixed(2)} once and can be used forever after manual verification.

Manual Textora verification can take some time. After paying the sender ID fee, you can come back later and check this chat for the approval update.

The free ${genericSenderId} sender ID has no sender ID fee.

Send the custom sender ID you want.

Rules:
- 1 to 11 characters
- Letters, numbers, spaces, and normal symbols only
- Cannot be only numbers
- Cannot start or end with a space
  `)
  })

  bot.action('try_another_sender_id', async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const session = userSessions[userId]

    if (!session) {
      return ctx.reply('Start again with /start to send a new bulk SMS.')
    }

    session.step = 'waiting_for_custom_sender_id'
    clearCustomSenderIdDetails(session)

    return ctx.reply(`
Send the custom sender ID you want.

Rules:
- 1 to 11 characters
- Letters, numbers, spaces, and normal symbols only
- Cannot be only numbers
- Cannot start or end with a space
  `)
  })

  bot.action('confirm_custom_sender_id', async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const session = userSessions[userId]

    if (!session || session.step !== 'confirming_custom_sender_id') {
      return ctx.reply('Start again with /start to send a new bulk SMS.')
    }

    session.senderIdType = 'custom'
    session.senderIdFee = customSenderIdFeeGHS
    session.senderVerificationStatus = 'fee_unpaid'

    return createSenderIdFeeCheckout(ctx, userId, session)
  })

  bot.action('cancel_custom_sender_id', async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const session = userSessions[userId]

    if (!session) return

    session.step = 'waiting_for_sender_choice'
    clearCustomSenderIdDetails(session)

    return ctx.reply(
      'Choose a sender ID option.',
      {
        reply_markup: {
          inline_keyboard: senderIdKeyboard(userId)
        }
      }
    )
  })

  bot.action(/^request_refund_(.+)$/, async (ctx) => {

    await answerCallback(ctx)

    const userId = ctx.from.id
    const requestId = ctx.match[1]
    const session = userSessions[userId]

    if (!session) {
      return ctx.reply('Session not found. Please start again with /start')
    }

    session.step = 'waiting_for_refund_momo_number'
    session.refundRequestId = requestId

    return ctx.reply(`
Please send your MoMo number for the refund.

Accepted formats:
233541234567
0541234567
+233541234567
    `)
  })

  bot.action(/^confirm_refund_(.+)$/, async (ctx) => {

    await answerCallback(ctx)

    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can confirm refunds.')
    }

    const refundId = ctx.match[1]
    const session = userSessions[refundId]

    if (!session || !session.refundMomoNumber) {
      return ctx.reply('Refund request not found or already processed.')
    }

    await ctx.reply('Refund marked as completed. Customer has been notified.')

    await bot.telegram.sendMessage(
      session.chatId,
      `✅ Your refund has been processed.

Amount: ₵${customSenderIdFeeGHS.toFixed(2)}
MoMo number: ${session.refundMomoNumber}

Thank you for using Textora SMS.`
    )

    delete session.refundMomoNumber
    delete session.refundRequestId
    session.step = 'waiting_for_sender_choice'
  })

  bot.on('text', async (ctx) => {

    const userId = ctx.from.id
    const session =
      userSessions[userId]

    if (!session) return

    if (session.step === 'waiting_for_contacts') {

      return acceptContacts(
        ctx,
        session,
        validateContactsFromText(ctx.message.text)
      )
    }

    if (session.step === 'waiting_for_message') {

      session.message = ctx.message.text
      session.smsUnits =
        calculateSMSUnits(session.message)
      session.step =
        'waiting_for_sender_choice'

      return ctx.reply(`
📊 SMS READY

👥 Contacts:
${session.contacts.length}

📨 SMS Units:
${session.smsUnits}

Choose your sender ID:

Free:
${genericSenderId}

Custom:
₵${customSenderIdFeeGHS.toFixed(2)} one-time fee, usable forever after manual Textora verification.

Previously verified custom IDs show as extra free options.
    `,
        {
          reply_markup: {
            inline_keyboard: senderIdKeyboard(userId)
          }
        }
      )
    }

    if (session.step === 'waiting_for_custom_sender_id') {

      const validation =
        validateSenderId(ctx.message.text)

      if (!validation.valid) {
        return ctx.reply(`
❌ ${validation.message}

Send another sender ID or choose the free ${genericSenderId} option from /start.
      `)
      }

      session.senderId = validation.value

      if (getVerifiedSenderIds(userId).includes(session.senderId)) {
        session.senderIdType = 'verified_custom'
        session.senderIdFee = 0
        session.senderVerificationStatus = 'verified'
        return createCheckout(ctx, userId, session)
      }

      session.step = 'waiting_for_sender_id_contact_number'

      return ctx.reply(`
Sender ID received:
${session.senderId}

Now send the phone number Textora should contact about this sender ID request.

Accepted formats:
233541234567
0541234567
+233541234567
      `)
    }

    if (session.step === 'waiting_for_sender_id_contact_number') {

      const contactResult =
        validateContactsFromText(ctx.message.text)

      if (contactResult.contacts.length !== 1 || contactResult.totalCandidates !== 1) {
        return ctx.reply(`
❌ Send one valid Ghana phone number for this sender ID request.

Accepted formats:
233541234567
0541234567
+233541234567
        `)
      }

      session.senderIdContactNumber =
        contactResult.contacts[0]

      session.step =
        'waiting_for_sender_id_use_case'

      return ctx.reply(`
Phone number received:
${session.senderIdContactNumber}

Now type the kind of messages you will use this sender ID to send.

Example:
Promotions, payment reminders, school announcements, church updates, delivery alerts, OTP/verification messages.
      `)
    }

    if (session.step === 'waiting_for_sender_id_use_case') {

      const useCase =
        ctx.message.text.trim()

      if (useCase.length < 5) {
        return ctx.reply('Please describe the message type/use case in a little more detail.')
      }

      session.senderIdUseCase =
        useCase

      session.step =
        'confirming_custom_sender_id'

      return ctx.reply(`
Please confirm this custom sender ID request.

Sender ID:
${session.senderId}

Contact number:
${session.senderIdContactNumber}

Message type/use case:
${session.senderIdUseCase}

Fee:
₵${customSenderIdFeeGHS.toFixed(2)}

You will pay this one-time fee now. Textora admin receives the approval request only after the fee is confirmed.

Approval can take some time. You can come back later and check this chat for the approval update.
    `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Pay sender ID fee',
                  callback_data: 'confirm_custom_sender_id'
                }
              ],
              [
                {
                  text: 'Cancel',
                  callback_data: 'cancel_custom_sender_id'
                }
              ]
            ]
          }
        }
      )
    }

    if (session.step === 'waiting_for_refund_momo_number') {

      const contactResult =
        validateContactsFromText(ctx.message.text)

      if (contactResult.contacts.length !== 1 || contactResult.totalCandidates !== 1) {
        return ctx.reply(`
❌ Send one valid Ghana MoMo number for the refund.

Accepted formats:
233541234567
0541234567
+233541234567
        `)
      }

      session.refundMomoNumber = contactResult.contacts[0]
      session.step = 'waiting_for_refund_confirmation'

      await ctx.reply(`
✅ Refund request received.

MoMo number: ${session.refundMomoNumber}
Amount: ₵${customSenderIdFeeGHS.toFixed(2)}

You will receive your refund soon.
      `)

      const refundId = session.refundRequestId || `${userId}_${Date.now()}`
      userSessions[refundId] = session

      return bot.telegram.sendMessage(
        process.env.DEVELOPER_CHAT_ID,
        `REFUND REQUEST

Customer chat: ${session.chatId}
Telegram user: ${userId}
MoMo number: ${session.refundMomoNumber}
Amount: ₵${customSenderIdFeeGHS.toFixed(2)}

After refunding, tap the button below.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Refunded',
                  callback_data: `confirm_refund_${refundId}`
                }
              ]
            ]
          }
        }
      )
    }

    if (session.step === 'waiting_for_sender_choice') {
      return ctx.reply('Choose a sender ID option using the buttons above.')
    }

    if (session.step === 'waiting_for_sender_id_contact_number') {
      return ctx.reply('Send one valid Ghana phone number for this sender ID request.')
    }

    if (session.step === 'waiting_for_sender_id_use_case') {
      return ctx.reply('Type the kind of messages you will use this sender ID to send.')
    }

    if (session.step === 'confirming_custom_sender_id') {
      return ctx.reply('Use the confirmation buttons above to pay the sender ID fee or cancel.')
    }

    if (session.step === 'waiting_for_sender_verification') {
      return ctx.reply('Your custom sender ID is still pending manual Textora verification. This can take some time. Textora will continue here when it is approved, so you can come back and check later.')
    }

    if (session.step === 'waiting_for_sender_id_fee_payment') {
      return ctx.reply('Open the Paystack checkout link above to pay the one-time sender ID fee.')
    }

    if (session.step === 'waiting_for_payment') {
      return ctx.reply('Open the Paystack checkout link above to complete payment.')
    }

    if (session.step === 'waiting_for_refund_confirmation') {
      return ctx.reply('Your refund request has been submitted. You will be notified when it is processed.')
    }
  })

  bot.on('document', async (ctx) => {

    const userId = ctx.from.id
    const session =
      userSessions[userId]

    if (!session || session.step !== 'waiting_for_contacts') {
      return
    }

    const document =
      ctx.message.document

    try {

      await ctx.reply('⏳ Reading contact file...')

      const buffer =
        await downloadTelegramFile(ctx, document.file_id, axios)

      const contactResult =
        extractContactsFromFile(document.file_name, buffer)

      return acceptContacts(ctx, session, contactResult)

    } catch (err) {

      console.log(
        'CONTACT FILE ERROR:',
        err.response?.data || err.message
      )

      return ctx.reply(
        'Could not read that contact file.\n\n' +
        (err.message || 'Upload a .xlsx, .csv, .tsv, or .txt file.')
      )
    }
  })

  bot.catch((err, ctx) => {

    console.log(
      'BOT UPDATE ERROR:',
      {
        updateId: ctx.update?.update_id,
        error: err.response?.description || err.message
      }
    )
  })
}

module.exports = {
  registerBotHandlers
}
