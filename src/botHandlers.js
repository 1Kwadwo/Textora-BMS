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

    session.step = 'waiting_for_sender_choice'
    delete session.senderId
    delete session.senderIdType
    delete session.senderIdFee
    delete session.senderIdFeePaid
    delete session.paymentPurpose
    delete session.senderVerificationStatus
    delete session.senderVerificationRequestId
    userSessions[session.userId] = session

    await ctx.reply('Rejected sender ID request. The customer has been notified.')

    return bot.telegram.sendMessage(
      session.chatId,
      `❌ Sender ID was not verified.

Please choose the free ${genericSenderId} sender ID or try another custom sender ID.`,
      {
        reply_markup: {
          inline_keyboard: senderIdKeyboard(session.userId)
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

The free ${genericSenderId} sender ID has no sender ID fee.

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
    delete session.senderId
    delete session.senderIdType
    delete session.senderIdFee
    delete session.senderIdFeePaid
    delete session.paymentPurpose

    return ctx.reply(
      'Choose a sender ID option.',
      {
        reply_markup: {
          inline_keyboard: senderIdKeyboard(userId)
        }
      }
    )
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
₵${customSenderIdFeeGHS.toFixed(2)} one-time fee, usable forever after manual Arkesel verification.

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

      session.step = 'confirming_custom_sender_id'

      return ctx.reply(`
Please confirm this custom sender ID.

Sender ID:
${session.senderId}

Fee:
₵${customSenderIdFeeGHS.toFixed(2)}

You will pay this one-time fee now. Textora admin receives the Arkesel approval request only after the fee is confirmed.
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

    if (session.step === 'waiting_for_sender_choice') {
      return ctx.reply('Choose a sender ID option using the buttons above.')
    }

    if (session.step === 'confirming_custom_sender_id') {
      return ctx.reply('Use the confirmation buttons above to pay the sender ID fee or cancel.')
    }

    if (session.step === 'waiting_for_sender_verification') {
      return ctx.reply('Your custom sender ID is still pending manual Arkesel verification. Textora will continue when it is approved.')
    }

    if (session.step === 'waiting_for_sender_id_fee_payment') {
      return ctx.reply('Open the Paystack checkout link above to pay the one-time sender ID fee.')
    }

    if (session.step === 'waiting_for_payment') {
      return ctx.reply('Open the Paystack checkout link above to complete payment.')
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
