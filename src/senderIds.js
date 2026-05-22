function validateSenderId(senderId) {

  const rawValue =
    senderId

  const value =
    rawValue.trim()

  if (value.length < 1 || value.length > 11) {
    return {
      valid: false,
      message: 'Sender ID must be 1 to 11 characters.'
    }
  }

  if (!/^[\x20-\x7E]+$/.test(value)) {
    return {
      valid: false,
      message: 'Sender ID can only contain normal letters, numbers, spaces, and symbols.'
    }
  }

  if (/^\d+$/.test(value)) {
    return {
      valid: false,
      message: 'Sender ID cannot be only numbers.'
    }
  }

  if (rawValue.startsWith(' ') || rawValue.endsWith(' ')) {
    return {
      valid: false,
      message: 'Sender ID cannot start or end with a space.'
    }
  }

  return {
    valid: true,
    value
  }
}

function buildSenderIdKeyboard({ userId, genericSenderId, customSenderIdFeeGHS, getVerifiedSenderIds }) {

  const keyboard = [
    [
      {
        text: `Use free ${genericSenderId}`,
        callback_data: 'use_generic_sender_id'
      }
    ]
  ]

  getVerifiedSenderIds(userId).forEach((senderId, index) => {
    keyboard.push([
      {
        text: `Use ${senderId}`,
        callback_data: `use_verified_sender_id_${index}`
      }
    ])
  })

  keyboard.push([
    {
      text: `Create custom ID - ₵${customSenderIdFeeGHS.toFixed(2)}`,
      callback_data: 'create_custom_sender_id'
    }
  ])

  return keyboard
}

module.exports = {
  buildSenderIdKeyboard,
  validateSenderId
}
