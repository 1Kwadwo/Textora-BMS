async function answerCallback(ctx) {

  try {
    await ctx.answerCbQuery()
  } catch (err) {
    console.log(
      'CALLBACK ANSWER ERROR:',
      err.response?.description || err.message
    )
  }
}

function isDeveloperApprovalContext(ctx) {

  const approverIds =
    [
      process.env.SENDER_ID_APPROVER_USER_IDS,
      process.env.DEVELOPER_USER_ID,
      process.env.DEVELOPER_CHAT_ID
    ]
      .filter(Boolean)
      .flatMap(value => String(value).split(','))
      .map(value => value.trim())
      .filter(Boolean)

  if (approverIds.includes(String(ctx.from.id))) {
    return true
  }

  return (
    String(ctx.chat.id) === String(process.env.DEVELOPER_CHAT_ID) &&
    ctx.chat.type === 'private'
  )
}

async function downloadTelegramFile(ctx, fileId, axios) {

  const fileUrl =
    await ctx.telegram.getFileLink(fileId)

  const response =
    await axios.get(fileUrl.href, {
      responseType: 'arraybuffer'
    })

  return Buffer.from(response.data)
}

module.exports = {
  answerCallback,
  downloadTelegramFile,
  isDeveloperApprovalContext
}
