const axios = require('axios')

// Customer text (names, emails, purposes) goes into these alerts, so we use
// HTML mode and escape it. Markdown mode made Telegram reject the whole alert
// whenever a customer typed an underscore or asterisk.
function escapeTelegramHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildSenderIdAlert({ user = {}, senderId, purpose, requestId, feeAmountGHS = 8, paymentMethod = 'Wallet Balance', createdAt, heading = 'NEW SENDER ID REQUEST (Web Portal)' }) {
  const e = escapeTelegramHtml
  const when = createdAt ? new Date(createdAt) : new Date()
  const text =
    `🏷️ <b>${e(heading)}</b>\n\n` +
    `👤 <b>User:</b> ${e(user.name || 'Client')}\n` +
    `📧 <b>Email:</b> <code>${e(user.email || 'N/A')}</code>\n` +
    `📱 <b>Phone:</b> <code>${e(user.phone || 'N/A')}</code>\n` +
    `🆔 <b>Requested Sender ID:</b> <code>${e(senderId)}</code>\n` +
    `💳 <b>Registration Fee:</b> ₵${Number(feeAmountGHS || 0).toFixed(2)} (Paid via ${e(paymentMethod)})\n` +
    `📝 <b>Purpose:</b> ${e(purpose || 'Business Messaging')}\n` +
    `⏱️ <b>Requested:</b> ${e(when.toLocaleString('en-GB', { timeZone: 'Africa/Accra' }))}\n\n` +
    `<i>Tap an option below to approve or reject this Sender ID for the user:</i>`

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: `✅ Approve "${String(senderId).slice(0, 20)}"`, callback_data: `approve_web_sid_${requestId}` },
        { text: '❌ Reject', callback_data: `reject_web_sid_${requestId}` }
      ]
    ]
  }

  return { text, replyMarkup }
}

async function sendTelegramSenderIdAlert(details) {
  const botToken = process.env.BOT_TOKEN
  const devChatId = process.env.DEVELOPER_CHAT_ID || '1341960525'

  if (!botToken || !devChatId) {
    console.error('[Telegram Alert] BOT_TOKEN or DEVELOPER_CHAT_ID is not set on this service, so the admin was NOT told about this sender ID request. Use /pendingsids in the bot to see it.')
    return null
  }

  const { text, replyMarkup } = buildSenderIdAlert(details)

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const res = await axios.post(url, {
      chat_id: devChatId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    }, { timeout: 15000 })
    console.log(`[Telegram Alert] Sent Sender ID approval prompt to Dev Chat ${devChatId} (Req ID: ${details.requestId})`)
    return res.data
  } catch (err) {
    console.error('[Telegram Alert Error]', err.response?.data || err.message)
    return null
  }
}

module.exports = {
  buildSenderIdAlert,
  escapeTelegramHtml,
  sendTelegramSenderIdAlert
}
