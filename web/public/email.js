/* KebSEND Email dashboard. Shares the login token and theme with the SMS dashboard. */
(function () {
  'use strict'

  const TOKEN_KEY = 'kebsend_auth_token'
  const THEME_KEY = 'kebsend_theme'
  let token = null
  try { token = localStorage.getItem(TOKEN_KEY) } catch (e) {}
  if (!token) { location.replace('/#login'); return }

  const $ = id => document.getElementById(id)
  const $$ = sel => Array.from(document.querySelectorAll(sel))
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmtCr = n => Number(n || 0).toFixed(2)
  const state = { overview: null, senders: [], templates: [], domains: [], sharedDomain: 'mail.kebsend.com', rate: 0.2, max: 50, logStatus: '', bodyTab: 'html', editingTpl: null, codeLang: 'curl' }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    })
    if (res.status === 401) { try { localStorage.removeItem(TOKEN_KEY) } catch (e) {} location.replace('/#login'); throw new Error('Signed out') }
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw new Error(data.message || data.error?.message || 'Request failed')
    return data
  }

  function toast(text) {
    $('em-toast-text').textContent = text
    $('em-toast').classList.remove('hidden')
    clearTimeout(toast.t)
    toast.t = setTimeout(() => $('em-toast').classList.add('hidden'), 2600)
  }
  function note(el, text, ok) {
    el.className = 'mt-2 text-sm font-semibold ' + (ok ? 'text-teal-700 dark:text-teal-300' : 'text-ember-700 dark:text-ember-300')
    el.textContent = text
  }

  const STATUS = {
    queued: ['Queued', 'wait'], accepted: ['Accepted', 'wait'], sent: ['Sent', 'wait'], delayed: ['Delayed', 'warn'],
    delivered: ['Delivered', 'ok'], bounced: ['Bounced', 'bad'], complained: ['Spam complaint', 'bad'], rejected: ['Rejected', 'bad'], failed: ['Failed', 'bad'],
    verified: ['Verified', 'ok'], pending: ['Waiting for DNS', 'warn']
  }
  const badge = s => { const [label, tone] = STATUS[s] || [s, 'mute']; return `<span class="em-badge em-badge-${tone}">${esc(label)}</span>` }
  const when = iso => {
    if (!iso) return '–'
    const d = new Date(iso)
    const today = new Date().toDateString() === d.toDateString()
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // ------------------------------------------------------------------ theme + sign out
  $('em-theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try { localStorage.setItem(THEME_KEY, next) } catch (e) {}
    if (state.overview) drawChart(state.overview.stats.days)
  })
  $('em-logout').addEventListener('click', () => { try { localStorage.removeItem(TOKEN_KEY) } catch (e) {} location.href = '/' })

  // ------------------------------------------------------------------ tabs
  const TABS = ['overview', 'send', 'logs', 'templates', 'domains', 'developers', 'smtp']
  function show(tab) {
    if (!TABS.includes(tab)) tab = 'overview'
    $$('.em-tab').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + tab))
    $$('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
    if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab)
    window.scrollTo(0, 0)
    LOADERS[tab] && LOADERS[tab]().catch(err => toast(err.message))
  }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-tab],[data-goto]')
    if (t) { e.preventDefault(); show(t.dataset.tab || t.dataset.goto) }
    const c = e.target.closest('[data-copy],[data-copy-target]')
    if (c) {
      const text = c.dataset.copy ?? $(c.dataset.copyTarget).textContent
      navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed'))
    }
  })
  window.addEventListener('hashchange', () => show(location.hash.slice(1)))

  // ------------------------------------------------------------------ overview
  function setBalance(b) {
    $('em-head-balance').textContent = fmtCr(b) + ' Cr'
    $('em-side-balance').textContent = fmtCr(b) + ' Credits'
  }

  async function loadOverview() {
    const d = await api('/api/email/overview')
    state.overview = d
    state.sharedDomain = d.settings.sharedDomain
    state.rate = d.settings.creditsPerRecipient
    state.max = d.settings.maxRecipients
    $$('.em-shared').forEach(el => { el.textContent = state.sharedDomain })
    $$('.em-max').forEach(el => { el.textContent = state.max })
    $('em-side-rate').textContent = state.rate
    $('em-name').textContent = (d.user.name || 'there').split(' ')[0]
    setBalance(d.user.balance)

    const pause = $('em-paused')
    pause.classList.toggle('hidden', !d.account.paused)
    if (d.account.paused) pause.innerHTML = `<b>Email sending is paused.</b> ${esc(d.account.pausedReason)}. Contact KebSEND support so we can review it with you.`

    const s = d.stats
    $('st-total').textContent = s.total.toLocaleString()
    $('st-inflight').textContent = `${s.inFlight} on the way`
    $('st-delivered').textContent = s.delivered.toLocaleString()
    $('st-rate').textContent = s.deliveryRate == null ? 'Delivery rate –' : `Delivery rate ${s.deliveryRate}%`
    $('st-bounced').textContent = s.bounced.toLocaleString()
    $('st-complained').textContent = `${s.complained} spam complaint${s.complained === 1 ? '' : 's'}`
    $('st-failed').textContent = s.failed.toLocaleString()
    drawChart(s.days)

    // First-run checklist
    const steps = [
      { done: d.senders > 0, title: 'Choose a sender', text: `Create a free @${state.sharedDomain} address or connect your domain.`, tab: 'domains' },
      { done: d.user.balance >= state.rate, title: 'Have credits', text: `Each email costs ${state.rate} credits from your SMS wallet.`, href: '/#dashboard' },
      { done: s.total > 0, title: 'Send a test', text: 'Send one to yourself and watch it arrive in Email logs.', tab: 'send' }
    ]
    $('em-setup').classList.toggle('hidden', steps.every(x => x.done))
    $('em-setup-steps').innerHTML = steps.map((x, i) => `
      <li class="rounded-xl border ${x.done ? 'border-teal-200 bg-teal-50/60 dark:border-teal-500/20 dark:bg-teal-500/5' : 'border-navy-900/10 dark:border-white/10'} p-4">
        <div class="flex items-center gap-2 text-sm font-extrabold text-navy-900 dark:text-white">
          <span class="grid h-6 w-6 place-items-center rounded-full text-xs ${x.done ? 'bg-teal-500 text-white' : 'bg-cream-200 text-navy-900 dark:bg-white/10 dark:text-white'}">${x.done ? '✓' : i + 1}</span>${esc(x.title)}
        </div>
        <p class="mt-1.5 text-sm text-ink dark:text-slate-400">${esc(x.text)}</p>
        ${x.done ? '' : x.href ? `<a href="${x.href}" class="mt-2 inline-block text-sm font-bold text-ember-500">Top up →</a>` : `<button data-goto="${x.tab}" class="mt-2 text-sm font-bold text-ember-500">Open →</button>`}
      </li>`).join('')

    $('em-recent').innerHTML = d.recent.length ? d.recent.map(m => `
      <button class="em-row flex w-full items-center gap-3 px-1 py-3 text-left" data-msg="${esc(m.id)}">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-bold text-navy-900 dark:text-white">${esc(m.subject)}</div>
          <div class="truncate text-xs text-ink dark:text-slate-400">to ${esc(m.to.join(', '))} · ${when(m.created_at)}</div>
        </div>
        ${badge(m.status)}
      </button>`).join('') : '<p class="py-6 text-center text-sm text-ink dark:text-slate-400">No emails yet. Your sends will show up here.</p>'
  }

  // Stacked daily bars: delivered (teal) at the base, bounced/failed (orange) on top.
  function drawChart(days) {
    const box = $('em-chart')
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
    const ok = dark ? '#26C2B0' : '#0E9384'
    const bad = dark ? '#FF8A2A' : '#FF6A00'
    const grid = dark ? 'rgba(255,255,255,.08)' : 'rgba(10,42,102,.08)'
    const ink = dark ? '#94A3B8' : '#5B6B85'
    const W = Math.max(box.clientWidth, 280)
    const H = 160
    const pad = { l: 28, r: 4, t: 8, b: 22 }
    const max = Math.max(4, ...days.map(d => d.sent))
    const step = (W - pad.l - pad.r) / days.length
    const bw = Math.min(28, step * 0.6)
    const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max)
    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Emails per day for the last 14 days">`
    for (const v of [0, Math.round(max / 2), max]) {
      svg += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="${grid}"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="${ink}">${v}</text>`
    }
    days.forEach((d, i) => {
      const x = pad.l + i * step + (step - bw) / 2
      const other = Math.max(0, d.sent - d.delivered - d.problems)
      const okH = (H - pad.t - pad.b) * (d.delivered / max)
      const badH = (H - pad.t - pad.b) * (d.problems / max)
      const otherH = (H - pad.t - pad.b) * (other / max)
      let top = y(0)
      if (okH > 0) { svg += `<rect class="em-bar" x="${x}" y="${top - okH}" width="${bw}" height="${okH}" rx="3" fill="${ok}"/>`; top -= okH + (okH ? 2 : 0) }
      if (badH > 0) { svg += `<rect class="em-bar" x="${x}" y="${top - badH}" width="${bw}" height="${badH}" rx="3" fill="${bad}"/>`; top -= badH + 2 }
      if (otherH > 0) svg += `<rect class="em-bar" x="${x}" y="${top - otherH}" width="${bw}" height="${otherH}" rx="3" fill="${grid}"/>`
      if (i % 2 === 0 || days.length < 8) {
        const lbl = new Date(d.date + 'T00:00:00Z').toLocaleDateString([], { day: 'numeric', month: 'short', timeZone: 'UTC' })
        svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="${ink}">${lbl}</text>`
      }
      svg += `<rect data-i="${i}" x="${pad.l + i * step}" y="0" width="${step}" height="${H - pad.b}" fill="transparent"/>`
    })
    svg += '</svg><div class="em-chart-tip hidden"></div>'
    box.innerHTML = svg
    const tip = box.querySelector('.em-chart-tip')
    box.querySelectorAll('rect[data-i]').forEach(r => {
      r.addEventListener('mouseenter', () => {
        const d = days[r.dataset.i]
        tip.innerHTML = `${new Date(d.date + 'T00:00:00Z').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}<br>${d.sent} sent · ${d.delivered} delivered · ${d.problems} bounced/failed`
        tip.classList.remove('hidden')
        const x = Number(r.getAttribute('x')) + step / 2
        tip.style.left = Math.min(Math.max(0, x - 90), W - 190) + 'px'
        tip.style.top = '-8px'
      })
      r.addEventListener('mouseleave', () => tip.classList.add('hidden'))
    })
  }

  // ------------------------------------------------------------------ send
  async function loadSenders() {
    const d = await api('/api/email/senders')
    state.senders = d.senders
    state.sharedDomain = d.sharedDomain
  }
  async function loadTemplates() {
    state.templates = (await api('/api/email/templates')).templates
  }

  async function loadSend() {
    await Promise.all([loadSenders(), loadTemplates(), state.overview ? null : loadOverview()])
    const sel = $('em-from')
    const prev = sel.value
    const ready = state.senders.filter(s => s.ready)
    sel.innerHTML = ready.length
      ? ready.map(s => `<option value="${esc(s.from)}">${esc(s.from)}</option>`).join('')
      : '<option value="">No sender yet</option>'
    if (prev && ready.some(s => s.from === prev)) sel.value = prev
    const waiting = state.senders.length - ready.length
    $('em-from-help').innerHTML = !ready.length
      ? `Create a sender first under <button type="button" data-goto="domains" class="font-bold text-ember-500">Sender domains</button>.`
      : waiting ? `${waiting} sender${waiting > 1 ? 's are' : ' is'} waiting for domain verification.` : ''
    const tsel = $('em-template')
    const tprev = tsel.value
    tsel.innerHTML = '<option value="">No template</option>' + state.templates.map(t => `<option value="${esc(t._id)}">${esc(t.name)}</option>`).join('')
    tsel.value = tprev
    if (!$('em-html').value) {
      $('em-html').value = `<h2 style="color:#0A2A66;font-family:Arial,sans-serif">Payment received</h2>\n<p style="font-family:Arial,sans-serif;color:#334155">Hi Kofi,</p>\n<p style="font-family:Arial,sans-serif;color:#334155">We have received your payment of <b>GH₵ 150.00</b> for order #1042. Thank you!</p>`
      $('em-subject').value = $('em-subject').value || 'Your payment was received'
    }
    updatePreview()
  }

  function currentVars() {
    const out = {}
    $$('#em-vars input').forEach(i => { out[i.dataset.var] = i.value })
    return out
  }
  const fill = (s, vars, html) => String(s || '').replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, k) => (vars[k] ? (html ? esc(vars[k]) : vars[k]) : `{{${k}}}`))

  function countRecipients() {
    const n = v => v.split(/[\n,;]+/).map(x => x.trim()).filter(Boolean).length
    return n($('em-to').value) + n($('em-cc').value) + n($('em-bcc').value)
  }
  function updatePreview() {
    const vars = currentVars()
    $('pv-from').textContent = $('em-from').value || 'Your sender'
    $('pv-to').textContent = $('em-to').value.trim() || 'recipient'
    $('pv-subject').textContent = fill($('em-subject').value, vars) || 'Subject'
    const html = $('em-html').value.trim()
    $('pv-frame').srcdoc = html
      ? `<base target="_blank"><body style="margin:16px;font-family:Arial,sans-serif">${fill(html, vars, true)}</body>`
      : `<body style="margin:16px;font-family:Arial,sans-serif;white-space:pre-wrap;color:#334155">${esc(fill($('em-text').value, vars))}</body>`
    const n = countRecipients()
    $('em-cost').textContent = fmtCr(n * state.rate) + ' credits'
    $('em-cost-note').textContent = n ? `${n} recipient${n > 1 ? 's' : ''} × ${state.rate}` : ''
  }
  ;['em-from', 'em-to', 'em-cc', 'em-bcc', 'em-subject', 'em-html', 'em-text'].forEach(id => $(id).addEventListener('input', updatePreview))
  $('em-from').addEventListener('change', updatePreview)
  $('em-ccbcc-toggle').addEventListener('click', () => $('em-ccbcc').classList.toggle('hidden'))
  $$('.em-body-tab').forEach(b => b.addEventListener('click', () => {
    state.bodyTab = b.dataset.body
    $$('.em-body-tab').forEach(x => {
      const on = x === b
      x.classList.toggle('bg-white', on); x.classList.toggle('shadow-soft', on); x.classList.toggle('text-navy-900', on)
      x.classList.toggle('dark:bg-night-800', on); x.classList.toggle('text-ink', !on)
    })
    $('em-html').classList.toggle('hidden', state.bodyTab !== 'html')
    $('em-text').classList.toggle('hidden', state.bodyTab !== 'text')
  }))
  $('em-template').addEventListener('change', () => {
    const t = state.templates.find(x => x._id === $('em-template').value)
    const box = $('em-vars')
    if (!t) { box.classList.add('hidden'); box.innerHTML = ''; updatePreview(); return }
    $('em-subject').value = t.subject
    $('em-html').value = t.html
    $('em-text').value = t.text || ''
    box.classList.toggle('hidden', !t.variables.length)
    box.innerHTML = '<div class="text-xs font-bold uppercase tracking-wider text-ink">Fill in the placeholders</div>' + t.variables.map(v => `
      <label class="flex items-center gap-2 text-sm"><span class="w-28 shrink-0 font-mono text-[12px] text-navy-900 dark:text-slate-200">{{${esc(v)}}}</span>
      <input data-var="${esc(v)}" class="ks-input h-9 !py-1 text-sm"></label>`).join('')
    box.querySelectorAll('input').forEach(i => i.addEventListener('input', updatePreview))
    updatePreview()
  })

  $('em-send-form').addEventListener('submit', async e => {
    e.preventDefault()
    const out = $('em-send-result')
    const btn = $('em-send-btn')
    btn.disabled = true
    btn.textContent = 'Sending…'
    try {
      const tplId = $('em-template').value
      const body = {
        from: $('em-from').value,
        to: $('em-to').value,
        cc: $('em-cc').value || undefined,
        bcc: $('em-bcc').value || undefined,
        subject: $('em-subject').value,
        html: $('em-html').value || undefined,
        text: $('em-text').value || undefined
      }
      if (tplId) { body.template_id = tplId; body.variables = currentVars() }
      const d = await api('/api/email/send', { method: 'POST', body })
      setBalance(d.remaining_balance)
      out.className = 'rounded-xl bg-teal-50 p-3 text-sm text-teal-800 dark:bg-teal-500/10 dark:text-teal-200'
      out.innerHTML = `<b>Queued.</b> ${d.message.credits_charged} credits charged${d.message.suppressed_recipients.length ? `, skipped ${esc(d.message.suppressed_recipients.join(', '))} (suppressed)` : ''}. <button type="button" class="font-bold underline" data-msg="${esc(d.message.id)}">Track delivery</button>`
      state.overview = null
    } catch (err) {
      out.className = 'rounded-xl bg-ember-50 p-3 text-sm text-ember-800 dark:bg-ember-500/10 dark:text-ember-200'
      out.textContent = err.message
    } finally {
      out.classList.remove('hidden')
      btn.disabled = false
      btn.textContent = 'Send email'
    }
  })

  // ------------------------------------------------------------------ logs
  async function loadLogs() {
    const q = $('em-log-q').value.trim()
    const qs = new URLSearchParams({ limit: '100', ...(state.logStatus ? { status: state.logStatus } : {}), ...(q ? { q } : {}) })
    const { messages } = await api('/api/email/messages?' + qs)
    $('em-logs-body').innerHTML = messages.length ? messages.map(m => `
      <tr class="em-row" data-msg="${esc(m.id)}">
        <td class="whitespace-nowrap text-ink dark:text-slate-400">${when(m.created_at)}</td>
        <td class="max-w-[14rem] truncate font-semibold">${esc(m.to.join(', '))}</td>
        <td class="max-w-[12rem] truncate text-ink dark:text-slate-400">${esc(m.from.replace(/^.*<|>$/g, ''))}</td>
        <td class="max-w-[16rem] truncate">${esc(m.subject)}</td>
        <td>${badge(m.status)}</td>
        <td class="text-right font-mono text-[13px]">${m.refunded ? '<span class="text-ink line-through">' + fmtCr(m.credits_charged) + '</span>' : fmtCr(m.credits_charged)}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="py-10 text-center text-ink dark:text-slate-400">No emails match.</td></tr>'
  }
  $$('#em-log-filters .em-pill').forEach(p => p.addEventListener('click', () => {
    state.logStatus = p.dataset.status
    $$('#em-log-filters .em-pill').forEach(x => x.classList.toggle('active', x === p))
    loadLogs().catch(err => toast(err.message))
  }))
  let qTimer
  $('em-log-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => loadLogs().catch(err => toast(err.message)), 250) })

  // Message detail dialog
  document.addEventListener('click', async e => {
    const row = e.target.closest('[data-msg]')
    if (!row) return
    try {
      const { message: m } = await api('/api/email/messages/' + encodeURIComponent(row.dataset.msg))
      $('dt-status').innerHTML = badge(m.status)
      $('dt-subject').textContent = m.subject
      const meta = [
        ['From', m.from], ['To', m.to.join(', ')], ...(m.cc.length ? [['Cc', m.cc.join(', ')]] : []), ...(m.bcc.length ? [['Bcc', m.bcc.join(', ')]] : []),
        ['Reply-to', m.reply_to || '–'], ['Sent', new Date(m.created_at).toLocaleString()], ['Via', m.source === 'api' ? 'API' : 'Dashboard'],
        ['Credits', fmtCr(m.credits_charged) + (m.refunded ? ' (refunded)' : '')], ['Message id', m.id], ['Provider id', m.provider_message_id || '–'],
        ...(m.opens ? [['Opens', String(m.opens)]] : []), ...(m.suppressed_recipients.length ? [['Skipped', m.suppressed_recipients.join(', ') + ' (suppressed)']] : [])
      ]
      $('dt-meta').innerHTML = meta.map(([k, v]) => `<dt class="font-semibold text-ink dark:text-slate-400">${esc(k)}</dt><dd class="break-all font-medium text-navy-900 dark:text-slate-100 ${/id$/.test(k) ? 'font-mono text-[12px]' : ''}">${esc(v)}</dd>`).join('')
      $('dt-timeline').innerHTML = (m.history || []).map(h => `
        <li class="relative"><span class="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full ${STATUS[h.status]?.[1] === 'bad' ? 'bg-ember-500' : STATUS[h.status]?.[1] === 'ok' ? 'bg-teal-500' : 'bg-blue-400'}"></span>
          <div class="text-sm font-bold text-navy-900 dark:text-white">${esc(STATUS[h.status]?.[0] || h.status)} <span class="font-normal text-ink dark:text-slate-400">· ${new Date(h.at).toLocaleString()}</span></div>
          ${h.detail ? `<div class="text-xs text-ink dark:text-slate-400">${esc(h.detail)}</div>` : ''}</li>`).join('')
      $('dt-frame').srcdoc = m.html ? `<body style="margin:12px;font-family:Arial,sans-serif">${m.html}</body>` : `<body style="margin:12px;font-family:Arial,sans-serif;white-space:pre-wrap">${esc(m.text || 'Content removed after 30 days.')}</body>`
      $('em-detail').showModal()
    } catch (err) { toast(err.message) }
  })

  // ------------------------------------------------------------------ templates
  async function loadTemplatesTab() {
    await loadTemplates()
    renderTplList()
    if (!state.editingTpl && state.templates[0]) editTpl(state.templates[0])
    if (!state.templates.length) editTpl(null)
  }
  function renderTplList() {
    $('em-tpl-list').innerHTML = state.templates.length ? state.templates.map(t => `
      <button class="dash-surface-card block w-full p-4 text-left transition hover:border-navy-900/20 ${state.editingTpl && state.editingTpl._id === t._id ? '!border-ember-400 ring-1 ring-ember-400' : ''}" data-tpl="${esc(t._id)}">
        <div class="truncate font-bold text-navy-900 dark:text-white">${esc(t.name)}</div>
        <div class="truncate text-xs text-ink dark:text-slate-400">${esc(t.subject)}</div>
        <div class="mt-1 text-[11px] text-ink dark:text-slate-500">Edited ${when(t.updatedAt)}</div>
      </button>`).join('') : '<p class="rounded-2xl border border-dashed border-navy-900/15 p-5 text-sm text-ink dark:border-white/15 dark:text-slate-400">No templates yet. Your first one is open on the right.</p>'
    $$('[data-tpl]').forEach(b => b.addEventListener('click', () => editTpl(state.templates.find(t => t._id === b.dataset.tpl))))
  }
  const STARTER = `<table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;background:#FFF6EE;padding:24px">
  <tr><td>
    <table width="100%" align="center" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
      <tr><td style="font-size:20px;font-weight:bold;color:#0A2A66">Your code is {{code}}</td></tr>
      <tr><td style="padding-top:12px;color:#334155;font-size:15px;line-height:1.6">
        Hi {{name}}, use this code to finish signing in. It expires in 10 minutes.
      </td></tr>
    </table>
  </td></tr>
</table>`
  function editTpl(t) {
    state.editingTpl = t
    $('em-tpl-form').classList.remove('hidden')
    $('tpl-name').value = t ? t.name : 'Sign-in code'
    $('tpl-subject').value = t ? t.subject : 'Your sign-in code is {{code}}'
    $('tpl-html').value = t ? t.html : STARTER
    $('tpl-text').value = t ? t.text || '' : 'Hi {{name}}, your sign-in code is {{code}}. It expires in 10 minutes.'
    $('tpl-delete').classList.toggle('hidden', !t)
    $('tpl-msg').classList.add('hidden')
    renderTplList()
    tplPreview()
  }
  function tplPreview() {
    $('tpl-preview').srcdoc = `<body style="margin:0">${$('tpl-html').value}</body>`
    const vars = new Set()
    for (const s of [$('tpl-subject').value, $('tpl-html').value, $('tpl-text').value]) for (const m of s.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) vars.add(m[1])
    $('tpl-vars').innerHTML = vars.size ? '<span class="font-semibold text-ink">Placeholders:</span>' + [...vars].map(v => `<code class="em-code">{{${esc(v)}}}</code>`).join('') : '<span class="text-ink">No placeholders</span>'
  }
  ;['tpl-html', 'tpl-subject', 'tpl-text'].forEach(id => $(id).addEventListener('input', tplPreview))
  $('em-tpl-new').addEventListener('click', () => editTpl(null))
  $('em-tpl-form').addEventListener('submit', async e => {
    e.preventDefault()
    const body = { name: $('tpl-name').value, subject: $('tpl-subject').value, html: $('tpl-html').value, text: $('tpl-text').value }
    try {
      const d = state.editingTpl
        ? await api('/api/email/templates/' + state.editingTpl._id, { method: 'PUT', body })
        : await api('/api/email/templates', { method: 'POST', body })
      await loadTemplates()
      editTpl(state.templates.find(t => t._id === d.template._id))
      note($('tpl-msg'), 'Saved.', true)
    } catch (err) { note($('tpl-msg'), err.message, false) }
  })
  $('tpl-delete').addEventListener('click', async () => {
    if (!state.editingTpl || !confirm('Delete this template?')) return
    await api('/api/email/templates/' + state.editingTpl._id, { method: 'DELETE' })
    state.editingTpl = null
    await loadTemplatesTab()
  })
  $('tpl-use').addEventListener('click', async () => {
    if (!state.editingTpl) return toast('Save the template first')
    const id = state.editingTpl._id
    show('send')
    await loadSend()
    $('em-template').value = id
    $('em-template').dispatchEvent(new Event('change'))
  })

  // ------------------------------------------------------------------ domains
  async function loadDomains() {
    const [d] = await Promise.all([api('/api/email/domains'), loadSenders()])
    state.domains = d.domains
    state.sharedDomain = d.sharedDomain
    $$('.em-shared').forEach(el => { el.textContent = state.sharedDomain })
    const shared = state.senders.filter(s => s.type === 'shared')
    $('em-shared-list').innerHTML = shared.map(s => `
      <span class="inline-flex items-center gap-2 rounded-full border border-navy-900/10 bg-white py-1 pl-3 pr-1 text-sm dark:border-white/10 dark:bg-night-900">
        <span class="font-semibold text-navy-900 dark:text-white">${esc(s.displayName || '')}</span>
        <span class="font-mono text-[12px] text-ink dark:text-slate-400">${esc(s.address)}</span>
        <button class="btn btn-circle btn-ghost btn-xs text-ink" data-del-sender="${esc(s._id)}" title="Remove">✕</button>
      </span>`).join('')
    $('em-domain-list').innerHTML = state.domains.map(renderDomain).join('')
  }

  function renderDomain(d) {
    const ids = state.senders.filter(s => s.domainId === d.id)
    const dmarc = d.records.find(r => r.purpose === 'DMARC')
    const req = d.records.filter(r => r.purpose !== 'DMARC')
    const authStatus = p => {
      const rs = req.filter(r => r.purpose === p)
      if (!rs.length) return 'pending'
      return rs.every(r => r.status === 'verified') ? 'verified' : rs.some(r => r.status === 'failed') ? 'failed' : 'pending'
    }
    const pill = (label, st) => `<span class="em-badge em-badge-${st === 'verified' ? 'ok' : st === 'failed' ? 'bad' : 'warn'}">${label} ${st === 'verified' ? 'pass' : st === 'failed' ? 'fail' : 'not found yet'}</span>`
    const row = r => `
      <tr>
        <td class="font-mono text-[12px] font-bold">${esc(r.type)}${r.priority != null ? ` <span class="font-normal text-ink">(${r.priority})</span>` : ''}</td>
        <td><div class="flex items-center gap-1.5"><code class="em-code max-w-[14rem] truncate">${esc(r.name)}</code><button class="btn btn-ghost btn-xs px-1 text-ink" data-copy="${esc(r.name)}" title="Copy">⧉</button></div></td>
        <td><div class="flex items-center gap-1.5"><code class="em-code max-w-[22rem] truncate">${esc(r.value)}</code><button class="btn btn-ghost btn-xs px-1 text-ink" data-copy="${esc(r.value)}" title="Copy">⧉</button></div></td>
        <td class="text-xs text-ink">${esc(r.purpose)}</td>
        <td>${r.status === 'verified' ? '<span class="em-badge em-badge-ok">Found</span>' : r.status === 'failed' ? '<span class="em-badge em-badge-bad">Wrong value</span>' : '<span class="em-badge em-badge-warn">Not found yet</span>'}</td>
      </tr>`
    return `
    <article class="dash-surface-card overflow-hidden">
      <div class="flex flex-col gap-3 border-b border-navy-900/5 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6 dark:border-white/5">
        <div>
          <div class="flex flex-wrap items-center gap-2"><h3 class="text-lg font-extrabold text-navy-900 dark:text-white">${esc(d.name)}</h3>${badge(d.status)}</div>
          <div class="mt-1.5 flex flex-wrap gap-1.5">${pill('SPF', authStatus('SPF'))}${pill('DKIM', authStatus('DKIM'))}${pill('DMARC', dmarc?.status)}</div>
          <div class="mt-1.5 text-xs text-ink dark:text-slate-400">Added ${when(d.created_at)} · last checked ${when(d.last_checked_at)}${d.status === 'pending' ? ' · we re-check every few minutes' : ''}</div>
        </div>
        <div class="flex gap-2">
          <button class="ks-btn-ghost btn-sm h-10" data-verify="${esc(d.id)}">Check now</button>
          <button class="btn btn-ghost btn-sm h-10 text-ink" data-del-domain="${esc(d.id)}">Remove</button>
        </div>
      </div>
      ${d.status === 'verified' ? '' : `<div class="bg-cream-100/70 px-5 py-3 text-sm text-navy-900 sm:px-6 dark:bg-white/5 dark:text-slate-200"><b>Next:</b> sign in to wherever you bought ${esc(d.name)}, open its DNS settings, and add each record below exactly as shown. Changes usually show up within an hour, sometimes up to 48 hours.</div>`}
      <div class="overflow-x-auto">
        <table class="table table-sm w-full text-sm text-navy-900 dark:text-slate-200">
          <thead><tr class="text-ink dark:text-slate-400"><th>Type</th><th>Name / Host</th><th>Value</th><th>For</th><th>Status</th></tr></thead>
          <tbody>${req.map(row).join('')}</tbody>
        </table>
      </div>
      ${dmarc ? `<div class="border-t border-navy-900/5 p-5 sm:p-6 dark:border-white/5">
        <div class="flex flex-wrap items-center gap-2"><h4 class="text-sm font-extrabold text-navy-900 dark:text-white">DMARC (recommended)</h4>${dmarc.status === 'verified' ? '<span class="em-badge em-badge-ok">Found</span>' : '<span class="em-badge em-badge-mute">Optional</span>'}</div>
        <p class="mt-1 max-w-3xl text-sm text-ink dark:text-slate-400">${dmarc.status === 'verified' ? `Your domain already has a DMARC policy: <code class="em-code">${esc(dmarc.existingValue)}</code>` : 'Gmail and Yahoo expect a DMARC record from anyone sending in volume. Start with this monitoring-only record; it does not block any mail. Tighten it to <code class="em-code">p=quarantine</code> once all your mail passes.'}</p>
        ${dmarc.status === 'verified' ? '' : `<div class="mt-3 flex flex-wrap items-center gap-2 text-sm"><span class="font-mono text-[12px] font-bold">TXT</span><code class="em-code">_dmarc</code><code class="em-code">${esc(dmarc.value)}</code><button class="btn btn-ghost btn-xs text-ink" data-copy="${esc(dmarc.value)}">⧉ Copy</button></div>`}
      </div>` : ''}
      <div class="border-t border-navy-900/5 p-5 sm:p-6 dark:border-white/5">
        <h4 class="text-sm font-extrabold text-navy-900 dark:text-white">Sending addresses on ${esc(d.name)}</h4>
        <div class="mt-2 flex flex-wrap gap-2">${ids.map(s => `
          <span class="inline-flex items-center gap-2 rounded-full border border-navy-900/10 py-1 pl-3 pr-1 text-sm dark:border-white/10">
            <span class="font-semibold">${esc(s.displayName || '')}</span><span class="font-mono text-[12px] text-ink">${esc(s.address)}</span>
            <button class="btn btn-circle btn-ghost btn-xs text-ink" data-del-sender="${esc(s._id)}" title="Remove">✕</button></span>`).join('') || '<span class="text-sm text-ink dark:text-slate-400">Any address on this domain can send once it is verified. Save the ones you use most:</span>'}
        </div>
        <form class="mt-3 flex flex-col gap-2 sm:flex-row" data-add-identity="${esc(d.name)}">
          <div class="flex min-w-0 items-center rounded-xl border border-navy-900/10 bg-white pr-3 dark:border-white/10 dark:bg-night-900">
            <input name="local" class="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm font-semibold outline-none dark:text-white" placeholder="notifications">
            <span class="text-sm text-ink">@${esc(d.name)}</span>
          </div>
          <input name="display" class="ks-input h-10 sm:w-48" placeholder="Display name">
          <button class="ks-btn-navy btn-sm h-10 px-4">Save address</button>
        </form>
      </div>
    </article>`
  }

  $('em-domain-form').addEventListener('submit', async e => {
    e.preventDefault()
    const msg = $('em-domain-msg')
    try {
      await api('/api/email/domains', { method: 'POST', body: { name: $('em-domain').value } })
      $('em-domain').value = ''
      msg.classList.add('hidden')
      await loadDomains()
      toast('Domain added. Copy the DNS records below.')
    } catch (err) { note(msg, err.message, false) }
  })
  $('em-handle-form').addEventListener('submit', async e => {
    e.preventDefault()
    const msg = $('em-handle-msg')
    try {
      await api('/api/email/senders', { method: 'POST', body: { handle: $('em-handle').value, displayName: $('em-handle-name').value } })
      $('em-handle').value = ''
      $('em-handle-name').value = ''
      note(msg, 'Address created. You can send from it now.', true)
      state.overview = null
      await loadDomains()
    } catch (err) { note(msg, err.message, false) }
  })
  $('em-domain-list').addEventListener('submit', async e => {
    const f = e.target.closest('[data-add-identity]')
    if (!f) return
    e.preventDefault()
    try {
      await api('/api/email/senders', { method: 'POST', body: { address: `${f.local.value.trim()}@${f.dataset.addIdentity}`, displayName: f.display.value } })
      await loadDomains()
    } catch (err) { toast(err.message) }
  })
  document.addEventListener('click', async e => {
    const v = e.target.closest('[data-verify]')
    const dd = e.target.closest('[data-del-domain]')
    const ds = e.target.closest('[data-del-sender]')
    try {
      if (v) {
        v.disabled = true; v.textContent = 'Checking…'
        const { domain } = await api(`/api/email/domains/${v.dataset.verify}/verify`, { method: 'POST' })
        toast(domain.status === 'verified' ? `${domain.name} is verified. You can send from it now.` : 'Not all records are visible yet. We will keep checking.')
        await loadDomains()
      } else if (dd) {
        if (!confirm('Remove this domain? Emails can no longer be sent from it.')) return
        await api('/api/email/domains/' + dd.dataset.delDomain, { method: 'DELETE' })
        await loadDomains()
      } else if (ds) {
        await api('/api/email/senders/' + ds.dataset.delSender, { method: 'DELETE' })
        await loadDomains()
      }
    } catch (err) { toast(err.message); if (v) { v.disabled = false; v.textContent = 'Check now' } }
  })

  // ------------------------------------------------------------------ API keys
  const mask = k => k.slice(0, 14) + '••••••••' + k.slice(-4)
  async function loadKeys() {
    const { keys } = await api('/api/email/api-keys')
    $('em-keys-body').innerHTML = keys.length ? keys.map(k => `
      <tr>
        <td class="font-semibold">${esc(k.name)}</td>
        <td><div class="flex items-center gap-1"><code class="em-code">${esc(mask(k.key))}</code><button class="btn btn-ghost btn-xs px-1 text-ink" data-copy="${esc(k.key)}" title="Copy">⧉</button></div></td>
        <td class="whitespace-nowrap text-ink">${when(k.createdAt)}</td>
        <td class="text-right font-mono">${k.sentThisMonth}</td>
        <td class="whitespace-nowrap text-ink">${when(k.lastUsedAt)}</td>
        <td class="text-right"><button class="btn btn-ghost btn-xs text-error" data-revoke="${esc(k.id)}">Revoke</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="py-8 text-center text-ink dark:text-slate-400">No email keys yet. Create one to use the API.</td></tr>'
    $$('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Revoke this key? Apps using it will stop sending email immediately.')) return
      await api('/api/email/api-keys/' + b.dataset.revoke, { method: 'DELETE' })
      $('em-key-reveal').classList.add('hidden')
      loadKeys()
    }))
    renderCode(keys[0]?.key)
  }
  $('em-key-new').addEventListener('click', async () => {
    const name = prompt('Name this key (e.g. "Shop backend")', 'Website backend')
    if (name === null) return
    try {
      const { apiKey } = await api('/api/email/api-keys', { method: 'POST', body: { name } })
      $('em-key-value').textContent = apiKey.key
      $('em-key-reveal').classList.remove('hidden')
      loadKeys()
    } catch (err) { toast(err.message) }
  })
  function renderCode(key) {
    const k = key || 'ksnd_live_your_email_key'
    const from = state.senders.find(s => s.ready)?.address || `you@${state.sharedDomain}`
    const base = location.origin
    const ex = {
      curl: `curl -X POST ${base}/api/v1/email/send \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042-receipt" \\
  -d '{
    "from": "${from}",
    "to": "customer@example.com",
    "subject": "Payment Confirmation",
    "html": "<h2>Your payment was successful.</h2>"
  }'`,
      node: `const res = await fetch('${base}/api/v1/email/send', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer ' + process.env.KEBSEND_EMAIL_KEY,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    from: '${from}',
    to: 'customer@example.com',
    subject: 'Payment Confirmation',
    html: '<h2>Your payment was successful.</h2>'
  })
})
const data = await res.json() // { ok, id, status: 'queued', credits_charged }`,
      php: `$ch = curl_init('${base}/api/v1/email/send');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HTTPHEADER => [
    'Authorization: Bearer ' . getenv('KEBSEND_EMAIL_KEY'),
    'Content-Type: application/json',
  ],
  CURLOPT_POSTFIELDS => json_encode([
    'from' => '${from}',
    'to' => 'customer@example.com',
    'subject' => 'Payment Confirmation',
    'html' => '<h2>Your payment was successful.</h2>',
  ]),
]);
$data = json_decode(curl_exec($ch), true);`
    }
    $('em-code').textContent = ex[state.codeLang]
  }
  $$('.em-code-tab').forEach(b => b.addEventListener('click', () => {
    state.codeLang = b.dataset.lang
    $$('.em-code-tab').forEach(x => {
      const on = x === b
      x.classList.toggle('bg-white', on); x.classList.toggle('shadow-soft', on); x.classList.toggle('text-navy-900', on)
      x.classList.toggle('dark:bg-night-800', on); x.classList.toggle('text-ink', !on)
    })
    loadKeys().catch(() => renderCode())
  }))

  // ------------------------------------------------------------------ boot
  const LOADERS = {
    overview: loadOverview,
    send: loadSend,
    logs: loadLogs,
    templates: loadTemplatesTab,
    domains: loadDomains,
    developers: () => Promise.all([loadSenders(), loadKeys()]),
    smtp: async () => {}
  }
  if (!state.overview) loadOverview().catch(err => toast(err.message))
  show(location.hash.slice(1) || 'overview')

  // Keep in-flight statuses fresh while the page is open.
  setInterval(() => {
    if (document.hidden) return
    const tab = location.hash.slice(1) || 'overview'
    if (tab === 'overview') loadOverview().catch(() => {})
    if (tab === 'logs') loadLogs().catch(() => {})
  }, 8000)
  let resizeT
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => state.overview && drawChart(state.overview.stats.days), 150) })
})()
