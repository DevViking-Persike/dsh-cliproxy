// Transport behavior against a local server. No network, no proxy, no key:
// the endpoint is node:http on an OS-assigned port.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createAdapter } = require('../dsh/adapter.js')
const { resolveConfig } = require('../dsh/config.js')

/** Start a scripted endpoint; returns its base URL and the recorded requests. */
async function endpoint(handler) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      handler(req, res)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => server.close() }
}

/** An SSE responder that writes the given payloads then closes. */
function sse(payloads, { delayMs = 0, terminate = true } = {}) {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const write = async () => {
      for (const payload of payloads) {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        res.write(`data: ${payload}\n\n`)
      }
      if (terminate) res.write('data: [DONE]\n\n')
      res.end()
    }
    void write()
  }
}

/** Drive one stream to completion, collecting chunks. */
async function collect(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }], ...options,
  })) chunks.push(chunk)
  return chunks
}

/** An adapter pointed at one endpoint. */
function adapterFor(base, extra = {}) {
  return createAdapter({
    config: resolveConfig({ baseURL: base, ...extra }),
    resolveApiKey: () => Promise.resolve('test-key'),
  })
}

test('a normal stream yields chunks and finishes', async () => {
  const server = await endpoint(sse([
    '{"choices":[{"delta":{"content":"oi"},"finish_reason":"stop"}]}',
  ]))
  try {
    const chunks = await collect(adapterFor(server.base))

    assert.equal(chunks.at(-1).type, 'finish')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  } finally { server.close() }
})

test('the request carries the key and asks for usage', async () => {
  const server = await endpoint(sse(['{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}']))
  try {
    await collect(adapterFor(server.base))
    const sent = JSON.parse(server.requests[0].body)

    assert.equal(server.requests[0].headers.authorization, 'Bearer test-key')
    assert.equal(sent.stream, true)
    assert.deepEqual(sent.stream_options, { include_usage: true })
  } finally { server.close() }
})

test('HTTP statuses map onto the harness failure vocabulary', async () => {
  for (const [status, code] of [[401, 'AUTH'], [429, 'RATE_LIMIT'], [500, 'SERVER'], [418, 'HTTP_418']]) {
    const server = await endpoint((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"nope"}}')
    })
    try {
      await assert.rejects(collect(adapterFor(server.base)), err => err.code === code, `status ${status}`)
    } finally { server.close() }
  }
})

test('a 400 naming the context window is recoverable, not INVALID_REQUEST', async () => {
  const server = await endpoint((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end('{"error":{"message":"maximum context length is 8192 tokens"}}')
  })
  try {
    await assert.rejects(collect(adapterFor(server.base)), err => err.code === 'CONTEXT_WINDOW_EXCEEDED')
  } finally { server.close() }
})

test('a provider retry-after survives to the failure the retry plugin reads', async () => {
  const server = await endpoint((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
    res.end('{"error":{"message":"slow down"}}')
  })
  try {
    await collect(adapterFor(server.base))
    assert.fail('expected a rejection')
  } catch (error) {
    // This is the whole point of carrying `failure`: without it the retry
    // plugin backs off on its own schedule and ignores the provider's.
    assert.equal(error.failure.code, 'RATE_LIMIT')
    assert.equal(error.failure.status, 429)
    assert.equal(error.failure.providerRetryAfterMs, 2000)
  } finally { server.close() }
})

test('a truncated stream fails instead of looking complete', async () => {
  const server = await endpoint(sse(['{"choices":[{"delta":{"content":"x"}}]}'], { terminate: false }))
  try {
    await assert.rejects(collect(adapterFor(server.base)), err => err.code === 'STREAM_CLOSED')
  } finally { server.close() }
})

test('an unreachable endpoint reports TRANSPORT and keeps the cause', async () => {
  const adapter = adapterFor('http://127.0.0.1:1/v1')

  await assert.rejects(collect(adapter), err => err.code === 'TRANSPORT' && err.cause !== undefined)
})

test('a caller abort is reported as ABORTED', async () => {
  const server = await endpoint(sse(
    ['{"choices":[{"delta":{"content":"a"}}]}', '{"choices":[{"delta":{"content":"b"}}]}'],
    { delayMs: 50 },
  ))
  const controller = new AbortController()
  try {
    setTimeout(() => { controller.abort() }, 20)
    await assert.rejects(collect(adapterFor(server.base), { signal: controller.signal }), err => err.code === 'ABORTED')
  } finally { server.close() }
})

test('an idle stream times out on its own budget', async () => {
  const server = await endpoint(sse(['{"choices":[{"delta":{"content":"x"}}]}'], { delayMs: 400 }))
  try {
    await assert.rejects(
      collect(adapterFor(server.base, { streamIdleTimeoutMs: 60 })),
      err => err.code === 'TIMEOUT',
    )
  } finally { server.close() }
})

test('a slow consumer does not trip the idle budget', async () => {
  // The budget covers silence from the server, not deliberation by the
  // consumer: the timer exists only while a read is outstanding.
  const server = await endpoint(sse([
    '{"choices":[{"delta":{"content":"a"}}]}',
    '{"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}',
  ]))
  try {
    const adapter = adapterFor(server.base, { streamIdleTimeoutMs: 120 })
    const chunks = []
    for await (const chunk of adapter.stream({
      model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) {
      chunks.push(chunk)
      await new Promise(r => setTimeout(r, 60))
    }

    assert.equal(chunks.at(-1).type, 'finish')
  } finally { server.close() }
})

test('image content is refused before any request is sent', async () => {
  const server = await endpoint(sse(['{"choices":[{"delta":{},"finish_reason":"stop"}]}']))
  try {
    await assert.rejects(
      collect(adapterFor(server.base), {
        messages: [{ role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/png' }] }],
      }),
      err => err.code === 'UNSUPPORTED_CONTENT',
    )
    assert.equal(server.requests.length, 0)
  } finally { server.close() }
})
