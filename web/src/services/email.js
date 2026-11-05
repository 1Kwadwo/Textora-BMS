const { Resend } = require('resend')

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return null
  return new Resend(apiKey)
}

function getFromEmail() {
  const envFrom = process.env.EMAIL_FROM
  if (envFrom) {
    return envFrom.replace(/Textora/gi, 'KebSEND')
  }
  return 'KebSEND <onboarding@resend.dev>'
}

const APP_URL = process.env.APP_URL || 'https://textora-bms-website.onrender.com'

async function sendPasswordResetEmail({ to, name, resetToken }) {
  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}`
  const logoUrl = `${APP_URL}/kebsend-logo.png`
  const fromEmail = getFromEmail()

  const resend = getResendClient()
  if (!resend) {
    console.warn('[Email] RESEND_API_KEY is not set. Reset link (dev/fallback):', resetUrl)
    return { ok: true, simulated: true, resetUrl }
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to,
      subject: 'Reset your KebSEND password',
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Password - KebSEND</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 40px 16px; -webkit-font-smoothing: antialiased;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05);">
            <!-- Header with Logo -->
            <tr>
              <td style="padding: 36px 36px 20px 36px; text-align: center;">
                <img src="${logoUrl}" alt="KebSEND" width="60" height="60" style="display: block; margin: 0 auto 14px auto; border-radius: 14px; border: 0;" />
                <h1 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px;">KebSEND</h1>
                <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px; font-weight: 500;">Bulk SMS & Developer API Gateway</p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding: 0 36px;">
                <div style="border-top: 1px solid #f1f5f9;"></div>
              </td>
            </tr>

            <!-- Content -->
            <tr>
              <td style="padding: 28px 36px 36px 36px;">
                <h2 style="color: #0f172a; margin: 0 0 12px 0; font-size: 19px; font-weight: 700;">Password Reset Request</h2>
                <p style="color: #475569; margin: 0 0 20px 0; font-size: 15px; line-height: 1.6;">
                  Hi ${name || 'there'},
                </p>
                <p style="color: #475569; margin: 0 0 28px 0; font-size: 15px; line-height: 1.6;">
                  We received a request to reset the password for your KebSEND account. Click the button below to choose a new password:
                </p>

                <!-- Action Button -->
                <div style="text-align: center; margin: 0 0 28px 0;">
                  <a href="${resetUrl}" style="display: inline-block; background: #0284c7; color: #ffffff; padding: 14px 32px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 15px; letter-spacing: 0.2px; box-shadow: 0 2px 6px rgba(2, 132, 199, 0.3);">
                    Reset Password
                  </a>
                </div>

                <div style="background-color: #f8fafc; border-radius: 10px; padding: 14px 18px; border: 1px solid #e2e8f0; margin-bottom: 24px;">
                  <p style="color: #64748b; margin: 0; font-size: 13px; line-height: 1.5;">
                    ⏱️ This password reset link is valid for <strong>1 hour</strong>. If you did not request this, you can safely ignore this email.
                  </p>
                </div>

                <p style="color: #94a3b8; margin: 0; font-size: 12px; line-height: 1.6;">
                  If the button does not work, copy and paste this link in your browser:<br>
                  <a href="${resetUrl}" style="color: #0284c7; word-break: break-all;">${resetUrl}</a>
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #f8fafc; padding: 22px 36px; border-top: 1px solid #e2e8f0; text-align: center;">
                <p style="color: #64748b; margin: 0 0 4px 0; font-size: 12px; font-weight: 600;">KebSEND Technologies</p>
                <p style="color: #94a3b8; margin: 0; font-size: 12px;">Fast, Reliable SMS Delivery for Ghana · Accra, Ghana</p>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    })

    if (error) {
      console.error('[Email] Resend error:', error)
      return { ok: false, error }
    }

    console.log('[Email] Password reset sent to', to, '| id:', data?.id)
    return { ok: true, data }

  } catch (err) {
    console.error('[Email] Send failed:', err.message)
    return { ok: false, error: err.message }
  }
}

async function sendVerificationEmail({ to, name, code }) {
  const logoUrl = `${APP_URL}/kebsend-logo.png`
  const fromEmail = getFromEmail()

  const resend = getResendClient()
  if (!resend) {
    console.warn(`[Email] RESEND_API_KEY is not set. Verification code for ${to}: ${code}`)
    return { ok: true, simulated: true, code }
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to,
      subject: `${code} is your KebSEND verification code`,
      html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Verify your email - KebSEND</title>
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f1f5f9; margin: 0; padding: 40px 16px; -webkit-font-smoothing: antialiased;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 520px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05);">
            <!-- Header with Logo -->
            <tr>
              <td style="padding: 36px 36px 20px 36px; text-align: center;">
                <img src="${logoUrl}" alt="KebSEND" width="60" height="60" style="display: block; margin: 0 auto 14px auto; border-radius: 14px; border: 0;" />
                <h1 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.3px;">KebSEND</h1>
                <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px; font-weight: 500;">Bulk SMS & Developer API Gateway</p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding: 0 36px;">
                <div style="border-top: 1px solid #f1f5f9;"></div>
              </td>
            </tr>

            <!-- Content -->
            <tr>
              <td style="padding: 28px 36px 36px 36px;">
                <h2 style="color: #0f172a; margin: 0 0 12px 0; font-size: 19px; font-weight: 700;">Confirm your email address</h2>
                <p style="color: #475569; margin: 0 0 20px 0; font-size: 15px; line-height: 1.6;">
                  Hi ${name || 'there'},
                </p>
                <p style="color: #475569; margin: 0 0 24px 0; font-size: 15px; line-height: 1.6;">
                  Welcome to KebSEND! Please use the 6-digit confirmation code below to verify your email address and activate your account:
                </p>

                <!-- Code Card -->
                <div style="background-color: #f8fafc; border-radius: 12px; padding: 24px 20px; text-align: center; margin: 0 0 24px 0; border: 1px solid #e2e8f0;">
                  <span style="font-size: 36px; font-weight: 800; letter-spacing: 10px; color: #0284c7; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; display: inline-block; padding-left: 10px;">${code}</span>
                  <p style="color: #64748b; margin: 10px 0 0 0; font-size: 13px; font-weight: 500;">
                    Valid for 15 minutes · Do not share this code
                  </p>
                </div>

                <p style="color: #94a3b8; margin: 0; font-size: 13px; line-height: 1.5;">
                  If you did not create an account on KebSEND, you can safely ignore this email.
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background-color: #f8fafc; padding: 22px 36px; border-top: 1px solid #e2e8f0; text-align: center;">
                <p style="color: #64748b; margin: 0 0 4px 0; font-size: 12px; font-weight: 600;">KebSEND Technologies</p>
                <p style="color: #94a3b8; margin: 0; font-size: 12px;">Enterprise Bulk SMS Platform for Ghana & West Africa · Accra, Ghana</p>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `
    })

    if (error) {
      console.error('[Email] Resend error:', error)
      return { ok: false, error }
    }

    console.log('[Email] Verification code sent to', to, '| id:', data?.id)
    return { ok: true, data }
  } catch (err) {
    console.error('[Email] Send failed:', err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = { sendPasswordResetEmail, sendVerificationEmail }

