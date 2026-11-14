/* Pay as you go: shared by the SMS dashboard and KebSEND Email.
   When a send is short of credits, the server returns a quote. This shows it,
   opens Paystack for just that amount, and waits for the send to go out. */
(function () {
  'use strict'

  const UNIT = { sms: 'SMS credits', transactional: 'transactional email credits', marketing: 'marketing email credits' }
  const $ = id => document.getElementById(id)
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const ghs = n => 'GH₵ ' + Number(n || 0).toFixed(2)
  const fmt = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
  const spinner = '<span class="loading loading-spinner loading-xs mr-2 align-middle text-ember-600"></span>'

  let opts = null
  let poll = null

  function status(html, tone) {
    const el = $('payg-status')
    el.className = 'mt-4 rounded-xl p-3 text-sm ' + (tone === 'ok'
      ? 'border border-teal-500/30 bg-teal-50 font-semibold text-teal-800 dark:bg-teal-500/10 dark:text-teal-300'
      : tone === 'bad' ? 'border border-ember-200 bg-ember-50 font-semibold text-ember-800 dark:border-ember-500/30 dark:bg-ember-500/10 dark:text-ember-200'
        : 'bg-cream-100 text-navy-900 dark:bg-night-900 dark:text-slate-200')
    el.innerHTML = html
  }
  function busy(on) {
    $('payg-pay').disabled = on
    $('payg-packages').classList.toggle('hidden', on)
  }

  async function call(path, init = {}) {
    const res = await fetch(path, { ...init, headers: { Authorization: 'Bearer ' + opts.token(), ...(init.body ? { 'Content-Type': 'application/json' } : {}) } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw new Error(data.message || data.error?.message || 'Request failed')
    return data
  }

  function watch(reference, payWindow) {
    clearInterval(poll)
    let n = 0
    const check = async () => {
      if (++n > 100) {
        clearInterval(poll)
        busy(false)
        status('We have not had a payment confirmation yet. If you paid, your message will still go out once Paystack confirms it.')
        return
      }
      let order
      try { order = (await call('/api/payg/verify?reference=' + encodeURIComponent(reference))).order } catch (e) { return }
      if (order.amountGHS) $('payg-amount').textContent = ghs(order.amountGHS)
      if (order.status === 'sent') {
        clearInterval(poll)
        if (payWindow && !payWindow.closed) { try { payWindow.close() } catch (e) {} }
        status('Payment confirmed and your message is on its way.', 'ok')
        opts.onSent && opts.onSent(order)
        setTimeout(() => { if ($('modal-payg').open) $('modal-payg').close() }, 2500)
      } else if (order.status === 'failed') {
        clearInterval(poll)
        if (payWindow && !payWindow.closed) { try { payWindow.close() } catch (e) {} }
        $('payg-pay').classList.add('hidden')
        $('payg-packages').classList.add('hidden')
        status(esc(order.message || 'The send did not go out.') + ' Press Send again to use them.', 'bad')
        opts.onFailed && opts.onFailed(order)
      }
    }
    poll = setInterval(check, 3000)
    check()
  }

  function show(o) {
    opts = o
    clearInterval(poll)
    $('payg-status').classList.add('hidden')
    $('payg-pay').classList.remove('hidden')
    busy(false)
    if (!$('modal-payg').open) $('modal-payg').showModal()
  }

  // quote: { product, needed, balance, credits, rateGHS, amountGHS }
  // checkout(): resolves { reference, checkout_url } for this send.
  function open({ quote, token, checkout, onSent, onFailed, onPackages }) {
    show({ token, onSent, onFailed })
    const unit = UNIT[quote.product] || 'credits'
    const short = Math.ceil(quote.needed - quote.balance - 1e-9)
    $('payg-summary').textContent = quote.balance > 0
      ? `This send needs ${fmt(quote.needed)} ${unit} and you have ${fmt(quote.balance)}. Pay for the rest and it goes out right away.`
      : `This send needs ${fmt(quote.needed)} ${unit}. Pay for just this send, no package needed.`
    $('payg-amount').textContent = ghs(quote.amountGHS)
    $('payg-rate').innerHTML = `${fmt(quote.credits)} credits at ${ghs(quote.rateGHS)} each` +
      (quote.credits > short ? `<br>${ghs(quote.minGHS)} minimum, the extra stays in your balance` : '')
    $('payg-pay').textContent = `Pay ${ghs(quote.amountGHS)} and send`
    $('payg-packages').onclick = () => { $('modal-payg').close(); onPackages && onPackages() }
    $('payg-pay').onclick = async () => {
      // Open the checkout window straight from the click so pop-up blockers allow it.
      const payWindow = window.open('', '_blank')
      busy(true)
      status(spinner + 'Opening secure checkout…')
      try {
        const d = await checkout()
        if (!payWindow) { location.href = d.checkout_url; return }
        payWindow.location.href = d.checkout_url
        status(`Checkout opened in a new tab. <a href="${esc(d.checkout_url)}" target="_blank" rel="noopener" class="font-bold text-ember-600 underline">Open it again</a><div class="mt-2 flex items-center gap-2 text-ink dark:text-slate-300">${spinner}Waiting for payment. Your message sends as soon as it is confirmed.</div>`)
        watch(d.reference, payWindow)
      } catch (err) {
        if (payWindow) payWindow.close()
        busy(false)
        status(esc(err.message), 'bad')
      }
    }
  }

  // Back from Paystack in this tab (pop-up was blocked): finish the send.
  function resume(reference, { token, onSent, onFailed }) {
    show({ token, onSent, onFailed })
    $('payg-summary').textContent = 'Confirming your payment.'
    $('payg-amount').textContent = '…'
    $('payg-rate').textContent = ''
    $('payg-pay').classList.add('hidden')
    $('payg-packages').classList.add('hidden')
    status(spinner + 'Waiting for Paystack. Your message sends as soon as it is confirmed.')
    watch(reference, null)
  }

  window.KebPayg = { open, resume, REF_PREFIX: 'web_payg_' }
})()
