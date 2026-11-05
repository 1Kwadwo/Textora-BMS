const { Resend } = require('resend')

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return null
  return new Resend(apiKey)
}

const FROM_EMAIL = process.env.EMAIL_FROM || 'Textora <onboarding@resend.dev>'
const APP_URL = process.env.APP_URL || 'https://textora-bms-website.onrender.com'

async function sendPasswordResetEmail({ to, name, resetToken }) {
  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}`

  const resend = getResendClient()
  if (!resend) {
    console.warn('[Email] RESEND_API_KEY is not set. Reset link (dev/fallback):', resetUrl)
    return { ok: true, simulated: true, resetUrl }
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Reset your Textora password',
      html: `
        <!DOCTYPE html>
        <html>
        <body style="font-family: Arial, sans-serif; background: #f4f4f5; margin: 0; padding: 0;">
          <div style="max-width: 520px; margin: 40px auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
            <div style="background: #2563eb; padding: 32px 40px;">
              <h1 style="color: white; margin: 0; font-size: 22px; font-weight: 700;">Textora</h1>
              <p style="color: #bfdbfe; margin: 6px 0 0; font-size: 13px;">Bulk SMS Platform</p>
            </div>
            <div style="padding: 36px 40px;">
              <h2 style="margin: 0 0 8px; color: #1e293b; font-size: 20px;">Reset your password</h2>
              <p style="color: #475569; margin: 0 0 24px; font-size: 15px;">Hi ${name || 'there'},</p>
              <p style="color: #475569; margin: 0 0 28px; font-size: 15px; line-height: 1.6;">
                We received a request to reset your Textora password. Click the button below to choose a new password. This link expires in <strong>1 hour</strong>.
              </p>
              <a href="${resetUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 13px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">
                Reset Password
              </a>
              <p style="color: #94a3b8; margin: 28px 0 0; font-size: 13px; line-height: 1.6;">
                If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.<br><br>
                Or copy this link: <a href="${resetUrl}" style="color: #2563eb; word-break: break-all;">${resetUrl}</a>
              </p>
            </div>
            <div style="background: #f8fafc; padding: 20px 40px; border-top: 1px solid #e2e8f0;">
              <p style="color: #94a3b8; margin: 0; font-size: 12px;">© ${new Date().getFullYear()} Textora · Bulk SMS for Ghana</p>
            </div>
          </div>
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

module.exports = { sendPasswordResetEmail }

