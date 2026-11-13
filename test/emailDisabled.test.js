const test = require('node:test')
const assert = require('node:assert')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

// Production-like setup with no Resend key: email must be switched off, never mocked.
delete process.env.EMAIL_PROVIDER
delete process.env.EMAIL_RESEND_API_KEY
delete process.env.MONGODB_URI
process.env.EMAIL_STORE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kebsend-email-off-')), 'store.json')

const { getProvider, isEmailEnabled } = require('../web/src/email/providers')
const engine = require('../web/src/email/engine')
const { UserRepo } = require('../web/src/models')

test('without a Resend key, email is switched off and nothing is charged', async () => {
  assert.strictEqual(getProvider().name, 'disabled')
  assert.strictEqual(isEmailEnabled(), false)

  const user = await UserRepo.create({ name: 'Off Test', email: `off_${Date.now()}@kebsend.test`, phone: '', passwordHash: 'x', initialBalance: 3, isVerified: true })
  const id = String(user._id || user.id)
  await assert.rejects(
    engine.sendEmail(user, { from: 'a@b.com', to: 'c@d.com', subject: 's', text: 't' }),
    err => err.status === 503 && err.code === 'email_not_enabled'
  )
  await assert.rejects(engine.addDomain(user, 'example-off.com'), err => err.status === 503)
  await assert.rejects(engine.handleWebhook(Buffer.from('{}'), {}), err => err.status === 404)
  assert.strictEqual((await UserRepo.findById(id)).balance, 3)
})
