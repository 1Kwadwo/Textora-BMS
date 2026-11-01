const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')

test('Textora Web Server runs and serves blueprint landing page, plans, and documentation', async (t) => {
  process.env.WEB_PORT = '4005'
  const server = require('../web/server.js')

  await new Promise(resolve => setTimeout(resolve, 300))

  function get(urlPath) {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:4005${urlPath}`, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }))
      }).on('error', reject)
    })
  }

  await t.test('GET / returns 200 and index.html', async () => {
    const res = await get('/')
    assert.strictEqual(res.statusCode, 200)
    assert.ok(res.headers['content-type'].includes('text/html'))
    assert.ok(res.body.includes('KEBSEND'))
    assert.ok(res.body.includes('blueprint-canvas'))
  })

  await t.test('GET /api/plans returns 200 and pricing matrix', async () => {
    const res = await get('/api/plans')
    assert.strictEqual(res.statusCode, 200)
    const json = JSON.parse(res.body)
    assert.strictEqual(json.ok, true)
    assert.strictEqual(json.pricing.localGHS, 0.05)
    assert.strictEqual(json.pricing.internationalGHS, 0.08)
    assert.ok(Array.isArray(json.plans))
    assert.strictEqual(json.plans.length, 8)
  })

  await t.test('GET /style.css returns CSS stylesheet', async () => {
    const res = await get('/style.css')
    assert.strictEqual(res.statusCode, 200)
    assert.ok(res.headers['content-type'].includes('text/css'))
    assert.ok(res.body.includes('--blueprint-blue'))
  })

  await t.test('GET /app.js returns client JS', async () => {
    const res = await get('/app.js')
    assert.strictEqual(res.statusCode, 200)
    assert.ok(res.headers['content-type'].includes('application/javascript'))
    assert.ok(res.body.includes('initScrollAnimations'))
  })

  await t.test('GET /illustrations/hero-telecom.svg returns SVG', async () => {
    const res = await get('/illustrations/hero-telecom.svg')
    assert.strictEqual(res.statusCode, 200)
    assert.ok(res.headers['content-type'].includes('image/svg+xml'))
    assert.ok(res.body.includes('<svg'))
  })

  server.close()
  await require('mongoose').disconnect().catch(() => {})
})
