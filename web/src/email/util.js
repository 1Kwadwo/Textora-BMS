// Parsing, validation and template helpers for the email module.

const config = {
  creditsPerRecipient: () => Number(process.env.EMAIL_CREDITS_PER_RECIPIENT || 0.2),
  sharedDomain: () => String(process.env.EMAIL_SHARED_DOMAIN || 'mail.kebsend.com').toLowerCase(),
  maxRecipients: () => Number(process.env.EMAIL_MAX_RECIPIENTS || 50),
  dailyCapUnpaid: () => Number(process.env.EMAIL_DAILY_CAP_UNPAID || 100),
  apiRatePerMinute: () => Number(process.env.EMAIL_API_RATE_PER_MIN || 60),
  maxHtmlBytes: 256 * 1024,
  retentionDays: () => Number(process.env.EMAIL_CONTENT_RETENTION_DAYS || 30)
}

// Practical address check: one @, no spaces or control chars, a dotted domain.
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/
const DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/

function isValidAddress(a) {
  return typeof a === 'string' && a.length <= 254 && ADDRESS_RE.test(a)
}
function isValidDomain(d) {
  return typeof d === 'string' && d.length <= 253 && DOMAIN_RE.test(d)
}

// "Name <a@b.com>" or "a@b.com" -> { name, address }. Returns null when invalid.
function parseMailbox(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (/[\r\n]/.test(s)) return null
  const m = s.match(/^(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>$/)
  const name = m ? (m[1] || '').trim() : ''
  const address = (m ? m[2] : s).toLowerCase()
  if (!isValidAddress(address)) return null
  if (/[<>"\\]/.test(name) || name.length > 100) return null
  return { name, address }
}

function formatMailbox({ name, address }) {
  return name ? `"${name.replace(/"/g, '')}" <${address}>` : address
}

// Accepts a string (comma / semicolon / newline separated) or an array.
// Returns { list, invalid }.
function parseAddressList(input) {
  if (input == null || input === '') return { list: [], invalid: [] }
  const parts = Array.isArray(input) ? input : String(input).split(/[\n,;]+/)
  const list = []
  const invalid = []
  for (const p of parts) {
    if (typeof p !== 'string' || !p.trim()) continue
    const mb = parseMailbox(p)
    if (!mb) invalid.push(String(p).trim())
    else if (!list.includes(mb.address)) list.push(mb.address)
  }
  return { list, invalid }
}

function domainOf(address) {
  return String(address).split('@').pop().toLowerCase()
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// {{ name }} placeholders. Values are HTML-escaped in HTML, left as-is in subject/text.
function renderTemplate(str, vars, { html = false } = {}) {
  if (!str) return str
  return String(str).replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : ''
    return html ? escapeHtml(v ?? '') : String(v ?? '')
  })
}
function templateVariables(...strs) {
  const out = new Set()
  for (const s of strs) for (const m of String(s || '').matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) out.add(m[1])
  return [...out]
}

// Very small HTML -> text fallback for when only HTML is given.
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const round2 = n => Number(Number(n).toFixed(2))

module.exports = {
  config, isValidAddress, isValidDomain, parseMailbox, formatMailbox, parseAddressList,
  domainOf, escapeHtml, renderTemplate, templateVariables, htmlToText, round2
}
