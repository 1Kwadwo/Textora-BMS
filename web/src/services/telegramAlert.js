const axios = require('axios')

async function sendTelegramSenderIdAlert({ user, senderId, purpose, requestId, feeAmountGHS = 1, paymentMethod = 'Wallet Balance' }) {
  const botToken = process.env.BOT_TOKEN
  const devChatId = process.env.DEVELOPER_CHAT_ID || '1341960525'

  if (!botToken || !devChatId) {
    console.log('[Telegram Alert] Missing bot token or dev chat id, skipping alert.')
    return null
  }

  const messageText = `🏷️ *NEW SENDER ID REQUEST (Web Portal)*\n\n` +
    `👤 *User:* ${user.name || 'Client'}\n` +
    `📧 *Email:* \`${user.email || 'N/A'}\`\n` +
    `📱 *Phone:* \`${user.phone || 'N/A'}\`\n` +
    `🆔 *Requested Sender ID:* \`${senderId}\`\n` +
    `💳 *Registration Fee:* ₵${Number(feeAmountGHS).toFixed(2)} (Paid via ${paymentMethod})\n` +
    `📝 *Purpose:* ${purpose || 'Business Messaging'}\n` +
    `⏱️ *Time:* ${new Date().toLocaleString()}\n\n` +
    `_Tap an option below to approve or reject this Sender ID for the user:_`

  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: `✅ Approve "${senderId}"`, callback_data: `approve_web_sid_${requestId}` },
        { text: `❌ Reject`, callback_data: `reject_web_sid_${requestId}` }
      ]
    ]
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const res = await axios.post(url, {
      chat_id: devChatId,
      text: messageText,
      parse_mode: 'Markdown',
      reply_markup: inlineKeyboard
    })
    console.log(`[Telegram Alert] Sent Sender ID approval prompt to Dev Chat ${devChatId} (Req ID: ${requestId})`)
    return res.data
  } catch (err) {
    console.error('[Telegram Alert Error]', err.response?.data || err.message)
    return null
  }
}

module.exports = {
  sendTelegramSenderIdAlert
}
