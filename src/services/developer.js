function createDeveloperService({
  bot,
  customSenderIdFeeGHS,
  forgetPendingSenderIdSession,
  rememberPendingSenderIdSession
}) {

  async function alertDeveloper(message) {

    const developerChatId =
      process.env.DEVELOPER_CHAT_ID

    if (!developerChatId) {
      console.log('DEVELOPER ALERT:', message)
      return
    }

    try {

      await bot.telegram.sendMessage(
        developerChatId,
        message
      )

    } catch (err) {

      console.log(
        'DEVELOPER ALERT ERROR:',
        err.response?.data || err.message
      )
    }
  }

  async function requestManualSenderIdApproval(session) {

    const requestId =
      `${session.userId}_${Date.now()}`

    const developerChatId =
      process.env.DEVELOPER_CHAT_ID

    if (!developerChatId) {
      return {
        status: 'failed',
        requestId,
        message: 'Developer chat ID is not configured.'
      }
    }

    try {

      rememberPendingSenderIdSession(requestId, session)

      await bot.telegram.sendMessage(
        developerChatId,
        `CUSTOM SENDER ID APPROVAL NEEDED

Sender ID: ${session.senderId}
Customer phone: ${session.senderIdContactNumber || 'Not provided'}
Message type/use case: ${session.senderIdUseCase || 'Not provided'}
Customer chat: ${session.chatId}
Telegram user: ${session.userId}
Contacts: ${session.contacts.length}
SMS units: ${session.smsUnits}
Sender ID fee: GHS ${customSenderIdFeeGHS.toFixed(2)}

Create/verify this Sender ID in the Arkesel dashboard. Approval can take some time. After Arkesel approves it, tap Approve below so Textora can continue to checkout.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Approve sender ID',
                  callback_data: `approve_sender_${requestId}`
                }
              ],
              [
                {
                  text: 'Reject sender ID',
                  callback_data: `reject_sender_${requestId}`
                }
              ]
            ]
          }
        }
      )

      return {
        status: 'pending',
        requestId
      }

    } catch (err) {

      console.log(
        'MANUAL SENDER ID APPROVAL ERROR:',
        err.response?.data || err.message
      )

      forgetPendingSenderIdSession(requestId)

      return {
        status: 'failed',
        requestId,
        message: err.response?.data?.message || err.message
      }
    }
  }

  return {
    alertDeveloper,
    requestManualSenderIdApproval
  }
}

module.exports = {
  createDeveloperService
}
