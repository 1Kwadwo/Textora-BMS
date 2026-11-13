// Email credit packs. Email credits are separate from SMS credits: one email
// credit sends one email to one recipient, and transactional and marketing
// credits are separate balances with their own prices.
//
// To change prices without a code change, set EMAIL_PRICING_JSON on the server
// to the same shape as DEFAULT_PRICING below (ids must stay unique).

const DEFAULT_PRICING = {
  transactional: {
    label: 'Transactional',
    blurb: 'OTPs, verification codes, password resets and receipts. Sent first, ahead of any campaign.',
    packs: [
      { id: 'tx-1k', emails: 1000, priceGHS: 30, tag: 'Starter' },
      { id: 'tx-5k', emails: 5000, priceGHS: 125, tag: 'Basic' },
      { id: 'tx-20k', emails: 20000, priceGHS: 400, tag: 'Growth', popular: true },
      { id: 'tx-100k', emails: 100000, priceGHS: 1500, tag: 'Scale' }
    ]
  },
  marketing: {
    label: 'Marketing',
    blurb: 'Newsletters, promotions and announcements. Every email gets an unsubscribe link.',
    packs: [
      { id: 'mk-2k', emails: 2000, priceGHS: 40, tag: 'Starter' },
      { id: 'mk-10k', emails: 10000, priceGHS: 160, tag: 'Basic' },
      { id: 'mk-50k', emails: 50000, priceGHS: 700, tag: 'Growth', popular: true },
      { id: 'mk-200k', emails: 200000, priceGHS: 2600, tag: 'Scale' }
    ]
  }
}

const PRODUCTS = ['transactional', 'marketing']

function validPacks(packs) {
  return Array.isArray(packs) && packs.length > 0 && packs.every(p =>
    p && typeof p.id === 'string' && Number(p.emails) > 0 && Number(p.priceGHS) > 0)
}

let cached = null
function pricing() {
  if (cached) return cached
  let out = DEFAULT_PRICING
  if (process.env.EMAIL_PRICING_JSON) {
    try {
      const custom = JSON.parse(process.env.EMAIL_PRICING_JSON)
      out = {}
      for (const product of PRODUCTS) {
        const c = custom[product] || {}
        out[product] = {
          ...DEFAULT_PRICING[product],
          ...c,
          packs: validPacks(c.packs) ? c.packs : DEFAULT_PRICING[product].packs
        }
      }
    } catch (e) {
      console.warn('[Email pricing] EMAIL_PRICING_JSON is not valid JSON, using default prices.')
      out = DEFAULT_PRICING
    }
  }
  // Per-email price for display, worked out from each pack.
  for (const product of PRODUCTS) {
    out[product].packs = out[product].packs.map(p => ({
      ...p,
      emails: Number(p.emails),
      priceGHS: Number(p.priceGHS),
      perEmailGHS: Number((Number(p.priceGHS) / Number(p.emails)).toFixed(4))
    }))
  }
  cached = out
  return out
}

function findPack(product, packId) {
  const p = pricing()[product]
  if (!p) return null
  return p.packs.find(x => x.id === String(packId)) || null
}

function isProduct(p) { return PRODUCTS.includes(p) }

function _reset() { cached = null }

module.exports = { pricing, findPack, isProduct, PRODUCTS, DEFAULT_PRICING, _reset }
