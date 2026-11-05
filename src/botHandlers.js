const fs = require('fs')
const path = require('path')
const { extractContactsFromFile, validateContactsFromText } = require('./contacts')
const { calculateSMSUnits, isGhanaNumber } = require('./pricing')
const { buildSenderIdKeyboard, validateSenderId } = require('./senderIds')
const {
  answerCallback,
  downloadTelegramFile,
  isDeveloperApprovalContext
} = require('./services/telegram')

const usersFilePath = path.join(__dirname, '..', 'users.json')

function loadUsers() {
  let users = []
  try {
    if (fs.existsSync(usersFilePath)) {
      users = JSON.parse(fs.readFileSync(usersFilePath, 'utf8'))
    }
  } catch (err) {
    console.log('Error loading users:', err.message)
  }

  // Seed from sender-ids.json to make sure we don't miss past users
  try {
    const senderIdsPath = path.join(__dirname, '..', 'sender-ids.json')
    if (fs.existsSync(senderIdsPath)) {
      const senderIds = JSON.parse(fs.readFileSync(senderIdsPath, 'utf8'))
      Object.keys(senderIds).forEach(id => {
        const numId = Number(id)
        if (!isNaN(numId) && !users.includes(numId)) {
          users.push(numId)
        }
      })
    }
  } catch (err) {
    console.log('Error seeding users from sender-ids.json:', err.message)
  }

  return users
}

function saveUsers(users) {
  try {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2))
  } catch (err) {
    console.log('Error saving users:', err.message)
  }
}

const loadedUsersSet = new Set(loadUsers())

function rememberUser(userId) {
  const numId = Number(userId)
  if (!isNaN(numId) && !loadedUsersSet.has(numId)) {
    loadedUsersSet.add(numId)
    saveUsers([...loadedUsersSet])
  }
}

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
  userSessions,
  apiDevelopersStore,
  apiLogsStore,
  paymentSessionStore,
  initializePayment,
  rememberPaymentSession,
  API_RECHARGE_PLANS
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
Local Ghana: 233541234567, 0541234567
International: +14155552671 (US), +447911123456 (UK)
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

    const localCount = contactResult.contacts.filter(isGhanaNumber).length
    const internationalCount = contactResult.contacts.length - localCount

    return ctx.reply(`
✅ ${contactResult.contacts.length} valid unique contacts uploaded.
  🇬🇭 Ghana: ${localCount}
  🌍 International: ${internationalCount}

Duplicates removed: ${contactResult.duplicates.length}
Invalid entries skipped: ${contactResult.invalid.length}

Now type the SMS message you want to send.
  `)
  }

  bot.use((ctx, next) => {
    if (ctx.from && ctx.from.id && !ctx.from.is_bot) {
      rememberUser(ctx.from.id)
    }
    return next()
  })

  bot.start((ctx) => {
    if (ctx.from && ctx.from.id) {
      rememberUser(ctx.from.id)
    }

    const keyboard = [
      [
        {
          text: '📨 Send Bulk SMS',
          callback_data: 'send_bulk'
        }
      ],
      [
        {
          text: '🔑 Developer API',
          callback_data: 'dev_api_profile'
        }
      ],
      [
        {
          text: '📄 Docs & Terms',
          callback_data: 'docs_menu'
        }
      ],
      [
        {
          text: '📖 Help',
          callback_data: 'help'
        }
      ]
    ]

    if (isDeveloperApprovalContext(ctx)) {
      keyboard.push([
        {
          text: '📢 Admin Broadcast',
          callback_data: 'admin_broadcast'
        }
      ])
    }

    ctx.reply(
      `🚀 Welcome to Textora SMS

Choose an option below:`,
      {
        reply_markup: {
          inline_keyboard: keyboard
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
    },
    {
      command: 'apikey',
      description: 'View/manage your developer API key'
    },
    {
      command: 'balance',
      description: 'Check your API SMS credits balance'
    },
    {
      command: 'recharge',
      description: 'Purchase API SMS credits'
    },
    {
      command: 'docs',
      description: 'Download platform documents & terms'
    }
  ]).catch(err => {
    console.error('Failed to set bot commands:', err.message)
    const isUnauthorized =
      err.code === 401 ||
      (err.response && err.response.error_code === 401) ||
      (err.message && (err.message.includes('401') || err.message.toLowerCase().includes('unauthorized')))
    if (isUnauthorized) {
      console.error('Critical error: Telegram bot token is unauthorized (401). Exiting...')
      process.exit(1)
    }
  })

  bot.action('help', async (ctx) => {

    await answerCallback(ctx)

    ctx.reply(`
📌 TEXTORA SMS COMMANDS

/start - Open Menu
/myid - Show your Telegram chat ID
/apikey - View/manage your developer API key
/balance - Check your API SMS credits balance
/recharge - Purchase API SMS credits
/docs - Download developer API docs & terms

📨 Bulk SMS Flow:
1. Paste contacts or upload .xlsx, .csv, .tsv, or .txt contacts
2. Type message
3. Choose free ${genericSenderId}, reuse an approved custom sender ID, or create a new one
4. New custom sender IDs cost ₵${customSenderIdFeeGHS.toFixed(2)} once before admin approval
5. After sender ID approval, pay only the SMS cost
6. SMS sends after Paystack confirms the SMS payment

🔑 Developer API Flow:
1. Tap "🔑 Developer API" or send /apikey to generate your API Key.
2. Tap "Buy API Credits" or send /recharge to purchase prepaid SMS credits.
3. Call the API from your backend servers using your key!
  `)
  })

  async function sendDocsMenu(ctx) {
    return ctx.reply(
      `📄 *Textora Platform Documents*\n\n` +
      `Select a document below to download as PDF:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📥 Developer API Documentation', callback_data: 'download_docs' }],
            [{ text: '📥 Terms of Service & Privacy Policy', callback_data: 'download_terms' }],
            [{ text: '⬅️ Back to Main Menu', callback_data: 'back_to_main' }]
          ]
        }
      }
    )
  }

  bot.command('docs', async (ctx) => {
    return sendDocsMenu(ctx)
  })

  bot.command('terms', async (ctx) => {
    return sendDocsMenu(ctx)
  })

  bot.action('docs_menu', async (ctx) => {
    await answerCallback(ctx)
    return sendDocsMenu(ctx)
  })

  bot.action('download_docs', async (ctx) => {
    await answerCallback(ctx)
    await ctx.reply('⏳ Preparing file, sending now...')
    await ctx.replyWithDocument({
      source: path.join(__dirname, '..', 'Textora_Architecture_Documentation.pdf'),
      filename: 'Textora_Architecture_Documentation.pdf'
    })
  })

  bot.action('download_terms', async (ctx) => {
    await answerCallback(ctx)
    await ctx.reply('⏳ Preparing file, sending now...')
    await ctx.replyWithDocument({
      source: path.join(__dirname, '..', 'Textora_Legal_Terms.pdf'),
      filename: 'Textora_Legal_Terms.pdf'
    })
  })

  bot.action('back_to_main', async (ctx) => {
    await answerCallback(ctx)
    const keyboard = [
      [
        {
          text: '📨 Send Bulk SMS',
          callback_data: 'send_bulk'
        }
      ],
      [
        {
          text: '🔑 Developer API',
          callback_data: 'dev_api_profile'
        }
      ],
      [
        {
          text: '📄 Docs & Terms',
          callback_data: 'docs_menu'
        }
      ],
      [
        {
          text: '📖 Help',
          callback_data: 'help'
        }
      ]
    ]

    if (isDeveloperApprovalContext(ctx)) {
      keyboard.push([
        {
          text: '📢 Admin Broadcast',
          callback_data: 'admin_broadcast'
        }
      ])
    }

    return ctx.reply(
      `🚀 Welcome to Textora SMS\n\nChoose an option below:`,
      {
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    )
  })

  bot.command('myid', async (ctx) => {

    return ctx.reply(
      `Your Telegram chat ID is:
${ctx.chat.id}`
    )
  })

  bot.command('resume', async (ctx) => {
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only Textora admin can resume transactions.')
    }
    const reference = ctx.message.text.split(' ')[1]
    if (!reference) {
      return ctx.reply('Usage: /resume <transaction_reference>')
    }
    await ctx.reply(`⏳ Attempting manual resume for transaction: ${reference}...`)
    try {
      await paymentProcessor(reference, { isManualResume: true })
    } catch (err) {
      await ctx.reply(`❌ Resume failed: ${err.message}`)
    }
  })

  bot.command('bypass', async (ctx) => {
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only Textora admin can bypass payment verification.')
    }
    const reference = ctx.message.text.split(' ')[1]
    if (!reference) {
      return ctx.reply('Usage: /bypass <transaction_reference>')
    }
    await ctx.reply(`⏳ Attempting bypass verification for transaction: ${reference}...`)
    try {
      await paymentProcessor(reference, { isBypassVerification: true })
    } catch (err) {
      await ctx.reply(`❌ Bypass failed: ${err.message}`)
    }
  })

  bot.command('apikey', async (ctx) => {
    const userId = ctx.from.id
    const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()
    const dev = await apiDevelopersStore.createOrGetDeveloper(userId, name)

    return ctx.reply(
      `🔑 *Textora Developer Profile*\n\n` +
      `👤 *Name:* ${dev.name}\n` +
      `💰 *Prepaid SMS Balance:* ${dev.balance} units\n` +
      `🔑 *API Key:* \`${dev.apiKey}\`\n\n` +
      `⚠️ *Keep this key secret!* Do not share it.\n\n` +
      `Use this key in your API request headers as:\n` +
      `\`Authorization: Bearer ${dev.apiKey}\`\n\n` +
      `To recharge your balance, click *Buy API Credits* below or type \`/recharge\`.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Regenerate API Key', callback_data: 'regenerate_api_key' }],
            [{ text: '💳 Buy API Credits', callback_data: 'buy_api_credits' }],
            [{ text: '📄 View Usage Logs', callback_data: 'view_api_logs' }]
          ]
        }
      }
    )
  })

  bot.command('balance', async (ctx) => {
    const userId = ctx.from.id
    const dev = await apiDevelopersStore.getDeveloperByUserId(userId)
    if (!dev) {
      return ctx.reply('You do not have a developer API profile yet. Send /apikey to create one.')
    }
    return ctx.reply(`💰 *Your prepaid developer API balance:* ${dev.balance} SMS units.`)
  })

  bot.command('recharge', async (ctx) => {
    const userId = ctx.from.id
    const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()

    await apiDevelopersStore.createOrGetDeveloper(userId, name)

    const keyboard = API_RECHARGE_PLANS.map(plan => [{
      text: `GHS ${plan.priceGHS} (${plan.credits} units)`,
      callback_data: `buy_plan_${plan.id}`
    }])

    return ctx.reply(
      `💳 *Select an API SMS Package to Recharge:*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    )
  })

  bot.action('dev_api_profile', async (ctx) => {
    await answerCallback(ctx)
    const userId = ctx.from.id
    const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()
    const dev = await apiDevelopersStore.createOrGetDeveloper(userId, name)

    return ctx.reply(
      `🔑 *Textora Developer Profile*\n\n` +
      `👤 *Name:* ${dev.name}\n` +
      `💰 *Prepaid SMS Balance:* ${dev.balance} units\n` +
      `🔑 *API Key:* \`${dev.apiKey}\`\n\n` +
      `⚠️ *Keep this key secret!* Do not share it.\n\n` +
      `Use this key in your API request headers as:\n` +
      `\`Authorization: Bearer ${dev.apiKey}\`\n\n` +
      `To recharge your balance, click *Buy API Credits* below or type \`/recharge\`.`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Regenerate API Key', callback_data: 'regenerate_api_key' }],
            [{ text: '💳 Buy API Credits', callback_data: 'buy_api_credits' }],
            [{ text: '📄 View Usage Logs', callback_data: 'view_api_logs' }]
          ]
        }
      }
    )
  })

  bot.action('view_api_logs', async (ctx) => {
    await answerCallback(ctx)
    const userId = ctx.from.id
    const logs = await apiLogsStore.getApiUsageLogs(userId)
    if (logs.length === 0) {
      return ctx.reply('No API usage logs found for your developer profile.')
    }

    const recentLogs = logs.slice(-10).reverse()
    let text = `📄 *Recent API SMS Usage Logs (Last 10)*\n\n`
    recentLogs.forEach((log, idx) => {
      const date = new Date(log.timestamp).toLocaleDateString()
      text += `${idx + 1}. *${date}* - Sent *${log.recipientsCount}* SMS `
      text += `(Debited: *${log.unitsDebited}* units, Bal: *${log.remainingBalance}*)\n`
      text += `   _"${log.message.substring(0, 30)}${log.message.length > 30 ? '...' : ''}"_\n\n`
    })

    return ctx.reply(text, { parse_mode: 'Markdown' })
  })

  bot.action('regenerate_api_key', async (ctx) => {
    await answerCallback(ctx)
    const userId = ctx.from.id
    const dev = await apiDevelopersStore.regenerateApiKey(userId)
    if (!dev) {
      return ctx.reply('Developer profile not found.')
    }

    return ctx.reply(
      `✅ *API Key Regenerated!*\n\n` +
      `Your new API Key is:\n\`${dev.apiKey}\`\n\n` +
      `Make sure to update this key in your backend integrations.`,
      { parse_mode: 'Markdown' }
    )
  })

  bot.action('buy_api_credits', async (ctx) => {
    await answerCallback(ctx)
    const keyboard = API_RECHARGE_PLANS.map(plan => [{
      text: `GHS ${plan.priceGHS} (${plan.credits} units)`,
      callback_data: `buy_plan_${plan.id}`
    }])

    return ctx.reply(
      `💳 *Select an API SMS Package to Recharge:*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: keyboard
        }
      }
    )
  })

  bot.action(/^buy_plan_(\d+)$/, async (ctx) => {
    await answerCallback(ctx)
    const planId = parseInt(ctx.match[1], 10)
    const plan = API_RECHARGE_PLANS.find(p => p.id === planId)
    if (!plan) {
      return ctx.reply('Invalid package selection.')
    }

    const userId = ctx.from.id
    const name = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()
    await apiDevelopersStore.createOrGetDeveloper(userId, name)
    const price = plan.priceGHS.toFixed(2)
    const credits = plan.credits

    await ctx.reply(`⏳ Creating recharge checkout for ${credits} SMS units (₵${price})...`)

    try {
      const session = {
        price,
        credits,
        chatId: ctx.chat.id,
        userId: userId,
        paymentPurpose: 'textora_api_recharge',
        status: 'pending',
        step: 'waiting_for_payment'
      }

      const payment = await initializePayment(userId, session)
      if (!payment?.authorization_url || !payment?.reference) {
        throw new Error('Paystack did not return a checkout URL.')
      }

      await rememberPaymentSession(payment.reference, session)

      return ctx.reply(
        `💳 *API Recharge Checkout Ready!*\n\n` +
        `Amount: ₵${price}\n` +
        `Credits: ${credits} SMS units\n` +
        `Reference: \`${payment.reference}\`\n\n` +
        `Click the button below to pay via Mobile Money / Card:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💸 Pay ₵' + price, url: payment.authorization_url }],
              [{ text: '🔄 Check Payment Status', callback_data: `check_payment_${payment.reference}` }]
            ]
          }
        }
      )
    } catch (err) {
      console.log('API RECHARGE PAYMENT INIT ERROR:', err.message)
      return ctx.reply(`❌ Failed to initialize payment: ${err.message}`)
    }
  })

  bot.action(/^approve_recharge_(.+)$/, async (ctx) => {
    await answerCallback(ctx)

    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only Textora admins can approve recharges.')
    }

    const reference = ctx.match[1]
    const session = await paymentSessionStore.getSession(reference)
    if (!session) {
      return ctx.reply('Recharge session was not found or has already been approved.')
    }

    const dev = await apiDevelopersStore.creditDeveloperBalance(session.userId, session.credits)
    await paymentSessionStore.forgetSession(reference)

    const newBalance = dev ? dev.balance : session.credits
    const apiKey = dev ? dev.apiKey : ''

    await ctx.editMessageText(
      `✅ *Recharge Approved!*\n\n` +
      `Developer ID: \`${session.userId}\`\n` +
      `Credited: ${session.credits} units\n` +
      `New Prepaid Balance: ${newBalance} units\n` +
      (apiKey ? `API Key: \`${apiKey}\`` : ''),
      { parse_mode: 'Markdown' }
    )

    try {
      await bot.telegram.sendMessage(
        session.chatId,
        `🎉 *API Recharge Successful!*\n\n` +
        `Your account has been credited with *${session.credits}* SMS credits.\n` +
        `New Prepaid Balance: *${newBalance}* units.\n` +
        (apiKey ? `API Key: \`${apiKey}\`\n\n` : '\n') +
        `Thank you for using Textora API!`
      )
    } catch (err) {
      console.log('Failed to notify developer of approved recharge:', err.message)
    }
  })

  bot.command('credit', async (ctx) => {
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only Textora admins can credit developer balances.')
    }

    const text = (ctx.message?.text || '').trim()
    const parts = text.split(/\s+/)
    if (parts.length < 3) {
      return ctx.reply(
        `ℹ️ *Usage:* \`/credit <Developer_ID> <credits>\`\n\n` +
        `Example:\n\`/credit 7239869241 400\``,
        { parse_mode: 'Markdown' }
      )
    }

    const targetUserId = parts[1].trim()
    const amount = Number(parts[2])
    if (isNaN(amount) || amount <= 0) {
      return ctx.reply('❌ Amount must be a positive number of credits.')
    }

    const dev = await apiDevelopersStore.creditDeveloperBalance(targetUserId, amount)
    if (!dev) {
      return ctx.reply(`❌ Could not credit developer \`${targetUserId}\`.`, { parse_mode: 'Markdown' })
    }

    await ctx.reply(
      `✅ *Successfully Credited!*\n\n` +
      `Developer ID: \`${dev.userId}\`\n` +
      `Amount Credited: *${amount}* units\n` +
      `New Prepaid Balance: *${dev.balance}* units\n` +
      `API Key: \`${dev.apiKey}\``,
      { parse_mode: 'Markdown' }
    )

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `🎉 *API Account Credited!*\n\n` +
        `Your account has been credited with *${amount}* SMS units by Textora Admin.\n` +
        `New Prepaid Balance: *${dev.balance}* units.\n` +
        `API Key: \`${dev.apiKey}\`\n\n` +
        `Base URL: \`https://textora-bmsv2.onrender.com\`\n` +
        `Endpoint: \`POST /api/v1/send-sms\``,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.log('Failed to notify developer of admin credit:', err.message)
    }
  })

  bot.action(/^reject_recharge_(.+)$/, async (ctx) => {
    await answerCallback(ctx)

    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only Textora admins can reject recharges.')
    }

    const reference = ctx.match[1]
    const session = await paymentSessionStore.getSession(reference)
    if (!session) {
      return ctx.reply('Recharge session was not found or has already been handled.')
    }

    await paymentSessionStore.forgetSession(reference)

    await ctx.editMessageText(
      `❌ *Recharge Rejected*\n\n` +
      `Developer ID: \`${session.userId}\`\n` +
      `Amount: ₵${session.price}\n` +
      `Credits: ${session.credits} units`,
      { parse_mode: 'Markdown' }
    )

    try {
      await bot.telegram.sendMessage(
        session.chatId,
        `❌ Your API recharge request for *${session.credits}* credits (₵${session.price}) has been rejected/cancelled by the admin.`
      )
    } catch (err) {
      console.log('Failed to notify developer of rejected recharge:', err.message)
    }
  })


  bot.action('admin_broadcast', async (ctx) => {
    await answerCallback(ctx)
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can send broadcasts.')
    }

    const userId = ctx.from.id
    userSessions[userId] = {
      step: 'waiting_for_broadcast_content',
      userId,
      chatId: ctx.chat.id
    }

    return ctx.reply(
      '📢 *Admin Broadcast*\n\n' +
      'Please type the message you want to broadcast, or upload an image/picture with a caption. To cancel, type *cancel*.'
    )
  })

  bot.action('confirm_send_broadcast', async (ctx) => {
    await answerCallback(ctx)
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can send broadcasts.')
    }

    const userId = ctx.from.id
    const session = userSessions[userId]
    if (!session || session.step !== 'confirming_broadcast') {
      return ctx.reply('No active broadcast session found.')
    }

    await ctx.reply('⏳ Dispatching broadcast to all users...')

    const users = [...loadedUsersSet]
    let successCount = 0
    let failCount = 0

    for (const targetId of users) {
      try {
        if (session.broadcastType === 'photo') {
          await bot.telegram.sendPhoto(targetId, session.broadcastPhotoId, {
            caption: session.broadcastCaption
          })
        } else {
          await bot.telegram.sendMessage(targetId, session.broadcastText)
        }
        successCount++
      } catch (err) {
        console.log(`Failed to send broadcast to ${targetId}:`, err.message)
        failCount++
      }
    }

    delete userSessions[userId]

    return ctx.reply(
      `✅ *Broadcast Complete*\n\n` +
      `👥 Total recipients: ${users.length}\n` +
      `🎉 Successfully sent: ${successCount}\n` +
      `❌ Failed (blocked/inactive): ${failCount}`
    )
  })

  bot.action('cancel_broadcast', async (ctx) => {
    await answerCallback(ctx)
    const userId = ctx.from.id
    delete userSessions[userId]
    return ctx.reply('Broadcast cancelled.')
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

  // --------------------------------------------------------------------------
  // WEB DASHBOARD SENDER ID TELEGRAM APPROVAL & REJECTION ACTIONS
  // --------------------------------------------------------------------------
  bot.action(/^approve_web_sid_(.+)$/, async (ctx) => {
    await answerCallback(ctx)
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can approve sender IDs.')
    }

    const requestId = ctx.match[1]
    try {
      const { connectDB } = require('../web/src/db')
      await connectDB()
      const { UserRepo, SenderIdRequestRepo } = require('../web/src/models')
      const reqRecord = await SenderIdRequestRepo.findById(requestId)
      if (!reqRecord) {
        console.warn(`[Web Sender ID Approval] Request not found for ID: ${requestId}`)
        return ctx.reply('⚠️ Sender ID request not found or expired.')
      }

      await SenderIdRequestRepo.updateStatus(requestId, 'approved')
      await UserRepo.addSenderId(reqRecord.userId, reqRecord.senderId)

      const user = await UserRepo.findById(reqRecord.userId)
      const userDisplay = user ? `${user.name} (${user.email})` : reqRecord.userId

      await ctx.editMessageText(
        `✅ *Sender ID Approved*\n\n` +
        `• *Sender ID:* \`${reqRecord.senderId}\`\n` +
        `• *Approved For:* ${userDisplay}\n` +
        `• *Status:* Active\n` +
        `• *Approved At:* ${new Date().toLocaleString()}\n\n` +
        `_The user can now select "${reqRecord.senderId}" on their Web Dashboard and REST API._`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('[Web Sender ID Approval Error]', err)
      return ctx.reply(`Error approving Sender ID: ${err.message}`)
    }
  })

  bot.action(/^reject_web_sid_(.+)$/, async (ctx) => {
    await answerCallback(ctx)
    if (!isDeveloperApprovalContext(ctx)) {
      return ctx.reply('Only the Textora admin can reject sender IDs.')
    }

    const requestId = ctx.match[1]
    try {
      const { connectDB } = require('../web/src/db')
      await connectDB()
      const { UserRepo, SenderIdRequestRepo } = require('../web/src/models')
      const reqRecord = await SenderIdRequestRepo.findById(requestId)
      if (!reqRecord) {
        console.warn(`[Web Sender ID Rejection] Request not found for ID: ${requestId}`)
        return ctx.reply('⚠️ Sender ID request not found or expired.')
      }

      await SenderIdRequestRepo.updateStatus(requestId, 'rejected')
      const user = await UserRepo.findById(reqRecord.userId)
      const userDisplay = user ? `${user.name} (${user.email})` : reqRecord.userId

      await ctx.editMessageText(
        `❌ *Sender ID Rejected*\n\n` +
        `• *Sender ID:* \`${reqRecord.senderId}\`\n` +
        `• *User:* ${userDisplay}\n` +
        `• *Status:* Rejected\n` +
        `• *Rejected At:* ${new Date().toLocaleString()}`,
        { parse_mode: 'Markdown' }
      )
    } catch (err) {
      console.error('[Web Sender ID Rejection Error]', err)
      return ctx.reply(`Error rejecting Sender ID: ${err.message}`)
    }
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

    if (session.step === 'waiting_for_broadcast_content') {
      if (ctx.message.text.toLowerCase() === 'cancel') {
        delete userSessions[userId]
        return ctx.reply('Broadcast cancelled.')
      }

      session.broadcastType = 'text'
      session.broadcastText = ctx.message.text
      session.step = 'confirming_broadcast'

      return ctx.reply(
        `📝 *Broadcast Preview (Text)*\n\n` +
        `*Message:*\n${session.broadcastText}\n\n` +
        `Do you want to send this broadcast to all users?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Yes, Send', callback_data: 'confirm_send_broadcast' },
                { text: '❌ Cancel', callback_data: 'cancel_broadcast' }
              ]
            ]
          }
        }
      )
    }

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

  bot.on('photo', async (ctx) => {
    const userId = ctx.from.id
    const session = userSessions[userId]
    if (!session) return

    if (session.step === 'waiting_for_broadcast_content') {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]
      session.broadcastType = 'photo'
      session.broadcastPhotoId = photo.file_id
      session.broadcastCaption = ctx.message.caption || ''
      session.step = 'confirming_broadcast'

      return ctx.reply(
        `📸 *Broadcast Preview (Image)*\n\n` +
        (session.broadcastCaption ? `*Caption:*\n${session.broadcastCaption}\n\n` : '') +
        `Do you want to send this broadcast to all users?`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Yes, Send', callback_data: 'confirm_send_broadcast' },
                { text: '❌ Cancel', callback_data: 'cancel_broadcast' }
              ]
            ]
          }
        }
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
