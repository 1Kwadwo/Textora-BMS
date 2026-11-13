// Resend adapter. The only file in the app that talks to Resend for customer email.
const { Resend } = require('resend')
const { ProviderError } = require('./index')

const PURPOSE = { SPF: 'SPF', DKIM: 'DKIM', MX: 'MX', Receiving: 'MX', Tracking: 'OTHER' }
const DOMAIN_STATUS = {
  verified: 'verified',
  partially_verified: 'pending',
  pending: 'pending',
  not_started: 'pending',
  failed: 'failed',
  temporary_failure: 'pending',
  partially_failed: 'failed'
}
const RECORD_STATUS = { verified: 'verified', failed: 'failed' }

const EVENT_TYPES = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed'
}

function toError(error, fallback) {
  const status = Number(error?.statusCode || 0)
  const name = error?.name || 'provider_error'
  const retryable = status === 429 || status >= 500 || name === 'rate_limit_exceeded' || name === 'application_error' || name === 'internal_server_error'
  return new ProviderError(error?.message || fallback, { retryable, code: name, status })
}

function normalizeDomain(d) {
  return {
    providerDomainId: d.id,
    name: d.name,
    status: DOMAIN_STATUS[d.status] || 'pending',
    region: d.region,
    records: (d.records || []).map(r => ({
      purpose: PURPOSE[r.record] || 'OTHER',
      type: r.type,
      name: r.name,
      value: r.value,
      priority: r.priority ?? null,
      ttl: r.ttl || 'Auto',
      status: RECORD_STATUS[r.status] || 'pending'
    }))
  }
}

function createResendProvider({ apiKey, webhookSecret }) {
  if (!apiKey) throw new Error('EMAIL_RESEND_API_KEY is required when EMAIL_PROVIDER=resend')
  const resend = new Resend(apiKey)

  async function call(fn, what) {
    let res
    try {
      res = await fn()
    } catch (err) {
      // Network errors and timeouts are worth retrying.
      throw new ProviderError(`${what}: ${err.message}`, { retryable: true, code: 'network_error' })
    }
    if (res.error) throw toError(res.error, what + ' failed')
    return res.data
  }

  return {
    name: 'resend',

    async send(msg) {
      const payload = {
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html || undefined,
        text: msg.text || undefined,
        cc: msg.cc?.length ? msg.cc : undefined,
        bcc: msg.bcc?.length ? msg.bcc : undefined,
        replyTo: msg.replyTo || undefined,
        headers: msg.headers && Object.keys(msg.headers).length ? msg.headers : undefined,
        // Our own ids ride along so webhooks can always be traced back.
        tags: [{ name: 'kebsend_message_id', value: String(msg.id) }, ...(msg.tags || [])]
      }
      const data = await call(() => resend.emails.send(payload, { idempotencyKey: 'kebsend-' + msg.id }), 'Resend send')
      return { providerMessageId: data.id }
    },

    async createDomain(name) {
      return normalizeDomain(await call(() => resend.domains.create({ name }), 'Resend create domain'))
    },
    async getDomain(id) {
      return normalizeDomain(await call(() => resend.domains.get(id), 'Resend get domain'))
    },
    async verifyDomain(id) {
      await call(() => resend.domains.verify(id), 'Resend verify domain')
      return normalizeDomain(await call(() => resend.domains.get(id), 'Resend get domain'))
    },
    async deleteDomain(id) {
      await call(() => resend.domains.remove(id), 'Resend delete domain')
    },

    parseWebhook(rawBody, headers) {
      if (!webhookSecret) throw new ProviderError('RESEND_WEBHOOK_SECRET is not set', { code: 'webhook_unconfigured' })
      const payload = rawBody.toString('utf8')
      // Throws when the signature or timestamp is wrong.
      resend.webhooks.verify({
        payload,
        headers: { id: headers['svix-id'], timestamp: headers['svix-timestamp'], signature: headers['svix-signature'] },
        webhookSecret
      })
      const evt = JSON.parse(payload)
      const data = evt.data || {}
      return {
        providerEventId: headers['svix-id'],
        type: EVENT_TYPES[evt.type] || null,
        providerType: evt.type,
        providerMessageId: data.email_id,
        occurredAt: evt.created_at || data.created_at || new Date().toISOString(),
        recipients: Array.isArray(data.to) ? data.to : data.to ? [data.to] : [],
        bounceType: data.bounce?.type || null,
        detail: data.bounce?.message || data.failed?.reason || data.click?.link || null,
        raw: evt
      }
    }
  }
}

module.exports = { createResendProvider, normalizeDomain }
