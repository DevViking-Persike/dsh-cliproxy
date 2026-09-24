const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { once } = require('node:events')
const { createAdapter } = require('../dsh/adapter.js')
const { resolveConfig } = require('../dsh/config.js')
const plugin = require('../dsh/index.js')

async function endpoint(t, handler, extra = {}) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  })
  return createAdapter({
    config: resolveConfig({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, ...extra }),
    resolveApiKey: async () => 'proxy-test-key',
  })
}

test('discovery lists available Gemini ids, preserves known capabilities, and excludes other routes', async t => {
  const adapter = await endpoint(t, (req, res) => {
    assert.equal(req.url, '/v1/models')
    assert.equal(req.headers.authorization, 'Bearer proxy-test-key')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [
      { id: 'gemini-pro-agent', owned_by: 'antigravity' },
      { id: 'gemini-new-account-model', owned_by: 'google' },
      { id: 'claude-sonnet-4-6' },
    ] }))
  })
  const models = await adapter.listModels('cliproxy-gemini')
  assert.deepEqual(models.map(model => model.id), ['gemini-pro-agent', 'gemini-new-account-model'])
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.deepEqual(models[1].inputModalities, ['text'])
})

test('an explicit catalog supports aliases and restricts discovery to configured ids', async t => {
  const adapter = await endpoint(t, (_req, res) => {
    res.end(JSON.stringify({ data: [{ id: 'my-google-alias' }, { id: 'gemini-pro-agent' }] }))
  }, { geminiModels: [{ id: 'my-google-alias', name: 'My Gemini' }] })
  assert.deepEqual((await adapter.listModels('cliproxy-gemini')).map(model => model.id), ['my-google-alias'])
})

test('empty discovery stays empty instead of advertising unavailable default models', async t => {
  const adapter = await endpoint(t, (_req, res) => res.end('{"data":[]}'))
  assert.deepEqual(await adapter.listModels('cliproxy-gemini'), [])
})

test('proxy authentication failure exposes no response body or credential', async t => {
  const adapter = await endpoint(t, (_req, res) => {
    res.writeHead(401)
    res.end('rejected proxy-test-key')
  })
  await assert.rejects(adapter.listModels('cliproxy-gemini'), error => {
    assert.equal(error.code, 'AUTH')
    assert.equal(JSON.stringify(error).includes('proxy-test-key'), false)
    return true
  })
})

test('malformed and duplicate model records reject the catalog', async t => {
  for (const payload of [{}, { data: [{ id: '' }] }, { data: [{ id: 'x' }, { id: 'x' }] }]) {
    const adapter = await endpoint(t, (_req, res) => res.end(JSON.stringify(payload)))
    await assert.rejects(adapter.listModels('cliproxy-gemini'), error => error.code === 'INVALID_RESPONSE')
  }
})

test('model discovery supports caller cancellation and a bounded timeout', async t => {
  const adapter = await endpoint(t, () => {}, { modelDiscoveryTimeoutMs: 30 })
  await assert.rejects(adapter.listModels('cliproxy-gemini'), error => error.code === 'TIMEOUT')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(adapter.listModels('cliproxy-gemini', controller.signal), error => error.code === 'ABORTED')
})

test('static discovery opt-out never reads credentials', async () => {
  const adapter = createAdapter({
    config: resolveConfig({ discoverModels: false }),
    resolveApiKey: () => assert.fail('static catalogs do not read credentials'),
  })
  assert.ok((await adapter.listModels('cliproxy-gemini')).length > 0)
})

test('Gemini can register alone alongside the separate subscriptions plugin', async () => {
  const registered = []
  await plugin.apply({
    get: () => undefined,
    llm: { registerAdapter: providers => { registered.push(...providers); return () => {} } },
    effect: effect => effect(),
  }, { routes: ['gemini'] })
  assert.deepEqual(registered, ['cliproxy-gemini'])
  for (const routes of [[], ['gemini', 'gemini'], ['agy'], 'gemini']) {
    assert.throws(() => resolveConfig({ routes }), /routes/)
  }
  assert.throws(() => resolveConfig({ discoverModels: 'yes' }), /boolean/)
  assert.throws(() => resolveConfig({ modelDiscoveryTimeoutMs: 0 }), /positive integer/)
})

test('prepared calls bind dispatch without model discovery or credential access', async t => {
  let requests = 0
  const adapter = await endpoint(t, (req, res) => {
    requests++
    assert.equal(req.url, '/v1/chat/completions')
    res.setHeader('content-type', 'text/event-stream')
    res.end('data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const prepared = await adapter.prepareCall('cliproxy-gemini', 'gemini-pro-agent')
  assert.equal(requests, 0)
  assert.equal(prepared.model.id, 'gemini-pro-agent')
  assert.equal(adapter.imageRequestPricing('cliproxy-gemini', 'gemini-pro-agent'), undefined)
  adapter.stream = () => assert.fail('prepared dispatch retains its original adapter')
  const chunks = []
  for await (const chunk of prepared.stream({ provider: 'cliproxy-gemini', model: 'gemini-pro-agent', messages: [] })) {
    chunks.push(chunk)
  }
  assert.equal(requests, 1)
  assert.equal(chunks.at(-1).type, 'finish')
})
