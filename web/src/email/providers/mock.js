// Mock provider for localhost and tests. Sends nothing.
// - Domains get realistic-looking DNS records and verify ~20 seconds after
//   they are added (domains containing "fail" never verify).
// - Each send produces sent + delivered events a moment later. Recipients
//   containing "bounce" bounce, "complain" complain, "delay" are delayed,
//   and "reject" is refused at submit time.
const crypto = require('crypto')
const { ProviderError } = require('./index')

const VERIFY_AFTER_MS = Number(process.env.EMAIL_MOCK_VERIFY_AFTER_MS || 20000)

function fakeDkim(name) {
  return 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQ' + crypto.createHash('sha256').update(name).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 120) + 'IDAQAB'
}

function domainFromId(id) {
  // id = mockdom_<createdAtMs>_<name>
  const [, ts, ...rest] = String(id).split('_')
  return { createdAt: Number(ts), name: rest.join('_') }
}

function buildDomain(id) {
  const { createdAt, name } = domainFromId(id)
  const failing = name.includes('fail')
  const ready = !failing && Date.now() - createdAt >= VERIFY_AFTER_MS
  const st = ready ? 'verified' : failing && Date.now() - createdAt >= VERIFY_AFTER_MS ? 'failed' : 'pending'
  return {
    providerDomainId: id,
    name,
    status: st,
    region: 'mock',
    records: [
      { purpose: 'DKIM', type: 'TXT', name: 'resend._domainkey', value: fakeDkim(name), priority: null, ttl: 'Auto', status: st },
      { purpose: 'SPF', type: 'MX', name: 'send', value: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10, ttl: 'Auto', status: st },
      { purpose: 'SPF', type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all', priority: null, ttl: 'Auto', status: st }
    ]
  }
}

function createMockProvider() {
  let sink = null
  const later = (ms, fn) => { const t = setTimeout(fn, ms); if (t.unref) t.unref() }

  function emit(type, providerMessageId, msg, extra = {}) {
    if (!sink) return
    sink({
      providerEventId: 'mockevt_' + crypto.randomBytes(8).toString('hex'),
      type,
      providerType: 'email.' + type,
      providerMessageId,
      occurredAt: new Date().toISOString(),
      recipients: msg.to,
      bounceType: null,
      detail: null,
      raw: { mock: true, type },
      ...extra
    }).catch(err => console.warn('[Email mock] event error', err.message))
  }

  return {
    name: 'mock',
    setEventSink(fn) { sink = fn },

    async send(msg) {
      const all = [...msg.to, ...(msg.cc || []), ...(msg.bcc || [])].join(' ')
      if (all.includes('reject')) {
        throw new ProviderError('The recipient address was refused by the provider.', { code: 'validation_error', status: 422 })
      }
      const providerMessageId = 'mock_' + crypto.randomUUID()
      later(400, () => emit('sent', providerMessageId, msg))
      if (all.includes('bounce')) {
        const bad = [...msg.to, ...(msg.cc || []), ...(msg.bcc || [])].filter(a => a.includes('bounce'))
        later(1500, () => emit('bounced', providerMessageId, msg, { recipients: bad, bounceType: 'Permanent', detail: `${bad.join(', ')}: the mailbox does not exist (550 5.1.1).` }))
      } else if (all.includes('complain')) {
        later(1200, () => emit('delivered', providerMessageId, msg))
        later(2500, () => emit('complained', providerMessageId, msg))
      } else if (all.includes('delay')) {
        later(1500, () => emit('delayed', providerMessageId, msg, { detail: 'Recipient server is busy, retrying.' }))
      } else {
        later(1200, () => emit('delivered', providerMessageId, msg))
        if (all.includes('open')) later(3000, () => emit('opened', providerMessageId, msg))
      }
      return { providerMessageId }
    },

    async createDomain(name) {
      return buildDomain(`mockdom_${Date.now()}_${name}`)
    },
    async getDomain(id) { return buildDomain(id) },
    async verifyDomain(id) { return buildDomain(id) },
    async deleteDomain() {},

    parseWebhook(rawBody) {
      // The mock accepts unsigned webhook posts so they can be tried by hand on localhost.
      const evt = JSON.parse(rawBody.toString('utf8'))
      return {
        providerEventId: evt.id || 'mockevt_' + crypto.randomBytes(8).toString('hex'),
        type: String(evt.type || '').replace(/^email\./, '').replace('delivery_delayed', 'delayed') || null,
        providerType: evt.type,
        providerMessageId: evt.data?.email_id,
        occurredAt: evt.created_at || new Date().toISOString(),
        recipients: evt.data?.to || [],
        bounceType: evt.data?.bounce?.type || null,
        detail: evt.data?.bounce?.message || null,
        raw: evt
      }
    }
  }
}

module.exports = { createMockProvider }
