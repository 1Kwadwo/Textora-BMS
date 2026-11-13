// Email delivery providers.
//
// Every provider implements the same interface, and nothing outside this
// folder knows which one is in use. To add Amazon SES, write providers/ses.js
// with these methods and set EMAIL_PROVIDER=ses.
//
//   name                                   short id stored on every message / domain
//   send(msg)                              -> { providerMessageId }
//                                             throws ProviderError { retryable, code }
//   createDomain(name)                     -> NormalizedDomain
//   getDomain(providerDomainId)            -> NormalizedDomain
//   verifyDomain(providerDomainId)         -> NormalizedDomain (asks the provider to re-check DNS)
//   deleteDomain(providerDomainId)         -> void
//   parseWebhook(rawBody, headers)         -> NormalizedEvent, throws if the signature is bad
//   setEventSink(fn)                       optional: providers that generate events themselves (mock)
//
// NormalizedDomain = { providerDomainId, name, status: 'pending'|'verified'|'failed',
//                      records: [{ purpose: 'SPF'|'DKIM'|'MX'|'DMARC'|'OTHER', type, name, value,
//                                  priority, ttl, status: 'pending'|'verified'|'failed' }] }
// NormalizedEvent  = { providerEventId, type, providerMessageId, occurredAt, recipients, bounceType, detail, raw }
//   type is one of: sent, delivered, delayed, bounced, complained, opened, clicked, failed, suppressed

class ProviderError extends Error {
  constructor(message, { retryable = false, code = 'provider_error', status } = {}) {
    super(message)
    this.retryable = retryable
    this.code = code
    this.status = status
  }
}

let active = null

function getProvider() {
  if (active) return active
  // With no key and no explicit EMAIL_PROVIDER, email stays switched off. The mock
  // provider is only ever used when EMAIL_PROVIDER=mock is set on purpose (local dev, tests).
  const wanted = (process.env.EMAIL_PROVIDER || (process.env.EMAIL_RESEND_API_KEY ? 'resend' : 'disabled')).trim().toLowerCase()
  if (wanted === 'disabled' || (wanted === 'resend' && !process.env.EMAIL_RESEND_API_KEY)) {
    active = createDisabledProvider(wanted === 'resend' ? 'EMAIL_PROVIDER=resend but EMAIL_RESEND_API_KEY is empty' : 'no EMAIL_RESEND_API_KEY set')
  } else if (wanted === 'resend') {
    const { createResendProvider } = require('./resend')
    active = createResendProvider({
      apiKey: process.env.EMAIL_RESEND_API_KEY,
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET
    })
  } else if (wanted === 'mock') {
    const { createMockProvider } = require('./mock')
    active = createMockProvider()
  } else {
    throw new Error(`Unknown EMAIL_PROVIDER "${wanted}". Use "resend" or "mock".`)
  }
  console.log(`[Email] Delivery provider: ${active.name}`)
  return active
}

// Placeholder used until a real provider is configured. Every call fails clearly.
function createDisabledProvider(reason) {
  const off = async () => { throw new ProviderError('Email sending is switched off: ' + reason, { code: 'email_disabled' }) }
  return {
    name: 'disabled',
    disabled: true,
    reason,
    send: off, createDomain: off, getDomain: off, verifyDomain: off, deleteDomain: off,
    parseWebhook() { throw new ProviderError('Email webhooks are switched off', { code: 'email_disabled' }) }
  }
}

function isEmailEnabled() {
  try { return !getProvider().disabled } catch (e) { return false }
}

// Tests can swap the provider.
function setProvider(p) { active = p }

module.exports = { getProvider, setProvider, isEmailEnabled, ProviderError }
