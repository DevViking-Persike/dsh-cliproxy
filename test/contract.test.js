// Registry conformance: the gate the harness applies at registration is
// re-run here, so a metadata mistake fails in this suite rather than at mount.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createAdapter } = require('../dsh/adapter.js')
const { resolveConfig } = require('../dsh/config.js')
const plugin = require('../dsh/index.js')

const config = resolveConfig()
const adapter = createAdapter({ config, resolveApiKey: () => Promise.resolve('k') })

test('provider metadata passes the registry gate for every route', () => {
  // packages/llm/llm/src/index.ts:383 — id must equal the requested provider
  // and name must be a non-empty string, or the whole registration is rejected.
  for (const route of config.routes) {
    const info = adapter.providerInfo(route.provider)
    assert.equal(info.id, route.provider)
    assert.equal(typeof info.name, 'string')
    assert.ok(info.name.length > 0)
  }
})

test('providerInfo never throws, even for a route it does not own', () => {
  // It is called synchronously inside registerAdapter for every requested
  // route; throwing there would reject routes that are perfectly valid.
  assert.doesNotThrow(() => adapter.providerInfo('desconhecido'))
})

test('the retry policy is flat, since the retry plugin reads it field by field', () => {
  const policy = adapter.providerRetryPolicy('cliproxy-claude')

  assert.equal(policy.mode, 'normal')
  assert.equal(typeof policy.initialDelayMs, 'number')
  assert.equal(typeof policy.maxDelayMs, 'number')
  assert.equal(typeof policy.jitterRatio, 'number')
  assert.ok(Array.isArray(policy.retryableCodes))
})

test('model entries satisfy the catalog gate', async () => {
  for (const route of config.routes) {
    const models = await adapter.listModels(route.provider)
    const ids = new Set()
    for (const model of models) {
      assert.equal(model.provider, route.provider)
      assert.ok(typeof model.id === 'string' && model.id.length > 0)
      assert.ok(typeof model.name === 'string' && model.name.length > 0)
      assert.equal(ids.has(model.id), false, `duplicate id ${model.id}`)
      ids.add(model.id)
    }
  }
})

test('an unknown route rejects rather than returning an empty list', async () => {
  await assert.rejects(adapter.listModels('nope'), err => err.code === 'INVALID_REQUEST')
  await assert.rejects(adapter.resolveModel('nope', 'm'), err => err.code === 'INVALID_REQUEST')
})

test('resolveModel echoes the exact route and model', async () => {
  const resolved = await adapter.resolveModel('cliproxy-claude', 'claude-opus-4-8')

  assert.equal(resolved.provider, 'cliproxy-claude')
  assert.equal(resolved.id, 'claude-opus-4-8')
  assert.ok(Number.isSafeInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0)
  assert.ok(Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0)
})

test('reasoning is omitted, never sent empty', async () => {
  // An empty efforts array is rejected outright; omission means the model
  // advertises no effort and an explicit request fails with a clear code.
  const resolved = await adapter.resolveModel('cliproxy-claude', 'claude-opus-4-8')

  assert.equal(Object.hasOwn(resolved, 'reasoning'), false)
})

test('an uncatalogued model resolves as text-only', async () => {
  const resolved = await adapter.resolveModel('cliproxy-openai', 'modelo-novo')

  assert.equal(resolved.id, 'modelo-novo')
  assert.deepEqual(resolved.inputModalities, ['text'])
  assert.equal(resolved.context.contextWindow, config.defaultContextWindow)
})

test('the plugin registers all three routes through an effect, and unload removes them', async () => {
  const registered = []
  let disposer
  const ctx = {
    get: () => undefined,
    llm: {
      registerAdapter: (providers) => {
        registered.push(...providers)
        return () => { registered.length = 0 }
      },
    },
    effect: (fn) => { disposer = fn() },
  }

  await plugin.apply(ctx, {})
  assert.deepEqual(registered, ['cliproxy-claude', 'cliproxy-openai', 'cliproxy-gemini'])

  disposer()
  assert.deepEqual(registered, [])
})

test('the plugin declares only the service it uses', () => {
  assert.deepEqual(plugin.inject, ['llm'])
})

test('a bad configuration fails at load, not on the first call', async () => {
  await assert.rejects(
    plugin.apply({ get: () => undefined, effect: () => {} }, { streamIdleTimeoutMs: -1 }),
    /positive integer/,
  )
  await assert.rejects(
    plugin.apply({ get: () => undefined, effect: () => {} }, { baseURL: 'ftp://x' }),
    /http\(s\) URL/,
  )
})
