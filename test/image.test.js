// Image input: capability gating, attachment resolution, and the wire form.
//
// The dangerous direction is over-claiming. A model that cannot see an image
// must refuse it before the message is durable, because a rejected image stays
// in the session log and every later turn resends it.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { createAdapter } = require('../dsh/adapter.js')
const { resolveConfig } = require('../dsh/config.js')
const { serializeMessagesWithImages } = require('../dsh/serialize.js')

const REF = { attachmentId: 'att-1', mediaType: 'image/png' }

/** An attachment service returning fixed bytes. */
function store(bytes = Uint8Array.of(1, 2, 3), mediaType = 'image/png') {
  return {
    calls: 0,
    readImage(ref) {
      this.calls += 1
      return Promise.resolve({ ref: { ...ref, mediaType }, data: bytes })
    },
  }
}

/** One user message carrying text and an image. */
const withImage = [{
  role: 'user',
  content: [{ type: 'text', text: 'o que é isto?' }, { type: 'image', attachment: REF }],
}]

/** Start a scripted endpoint; returns its URL and recorded bodies. */
async function endpoint() {
  const bodies = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}/v1`, bodies, close: () => server.close() }
}

/** Drive one stream to completion. */
async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

test('a vision model resolves the attachment into an ordered data URL', async () => {
  const attachments = store()
  const server = await endpoint()
  try {
    const adapter = createAdapter({
      config: resolveConfig({ baseURL: server.base }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => attachments,
    })

    await collect(adapter, { provider: 'cliproxy-gemini', model: 'gemini-3-flash', messages: withImage })
    const content = server.bodies[0].messages.at(-1).content

    // Order carries meaning: the text asks about the image that follows.
    assert.equal(content[0].type, 'text')
    assert.equal(content[1].image_url.url, 'data:image/png;base64,AQID')
  } finally { server.close() }
})

test('a text-only model refuses an image before any credential or network use', async () => {
  // gpt-5.3-codex-spark is text-only in the proxy's registry while its
  // siblings take images, which is why capability is per model.
  let keyReads = 0
  const server = await endpoint()
  try {
    const adapter = createAdapter({
      config: resolveConfig({ baseURL: server.base }),
      resolveApiKey: () => { keyReads += 1; return Promise.resolve('k') },
      resolveAttachments: () => store(),
    })

    await assert.rejects(
      collect(adapter, { provider: 'cliproxy-openai', model: 'gpt-5.3-codex-spark', messages: withImage }),
      err => err.code === 'UNSUPPORTED_CONTENT' && err.message.includes('gpt-5.3-codex-spark'),
    )
    assert.equal(keyReads, 0)
    assert.equal(server.bodies.length, 0)
  } finally { server.close() }
})

test('an uncatalogued model refuses images rather than assuming vision', async () => {
  const server = await endpoint()
  try {
    const adapter = createAdapter({
      config: resolveConfig({ baseURL: server.base }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => store(),
    })

    await assert.rejects(
      collect(adapter, { provider: 'cliproxy-gemini', model: 'modelo-novo', messages: withImage }),
      err => err.code === 'UNSUPPORTED_CONTENT',
    )
  } finally { server.close() }
})

test('a missing attachment service refuses the image instead of dropping it', async () => {
  const server = await endpoint()
  try {
    const adapter = createAdapter({
      config: resolveConfig({ baseURL: server.base }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => undefined,
    })

    await assert.rejects(
      collect(adapter, { provider: 'cliproxy-gemini', model: 'gemini-3-flash', messages: withImage }),
      err => err.code === 'UNSUPPORTED_CONTENT' && err.message.includes('attachment service'),
    )
  } finally { server.close() }
})

test('a text-only turn never touches the attachment service', async () => {
  const attachments = store()
  const server = await endpoint()
  try {
    const adapter = createAdapter({
      config: resolveConfig({ baseURL: server.base }),
      resolveApiKey: () => Promise.resolve('k'),
      resolveAttachments: () => attachments,
    })

    await collect(adapter, {
      provider: 'cliproxy-claude', model: 'claude-opus-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
    })

    assert.equal(attachments.calls, 0)
    // A text-only message keeps the compact string form every gateway accepts.
    assert.equal(server.bodies[0].messages.at(-1).content, 'oi')
  } finally { server.close() }
})

test('an image in assistant history is refused, since the role cannot carry one', async () => {
  // It would be dropped by the string path and stays durable, so every later
  // turn would drop it again.
  await assert.rejects(
    serializeMessagesWithImages([{ role: 'assistant', content: [{ type: 'image', attachment: REF }] }], store()),
    err => err.code === 'UNSUPPORTED_CONTENT' && err.message.includes('assistant'),
  )
})

test('an unsupported media type is refused by name', async () => {
  await assert.rejects(
    serializeMessagesWithImages(withImage, store(Uint8Array.of(1), 'image/tiff')),
    err => err.code === 'UNSUPPORTED_CONTENT' && err.message.includes('image/tiff'),
  )
})

test('an attachment refusal keeps its own code and message', async () => {
  const failing = {
    readImage() {
      return Promise.reject(Object.assign(new Error('attachment exceeds its size limit'), { code: 'INVALID_REQUEST' }))
    },
  }

  await assert.rejects(
    serializeMessagesWithImages(withImage, failing),
    err => err.code === 'INVALID_REQUEST' && err.message.includes('size limit'),
  )
})

test('tool-result images follow their string tool message', async () => {
  // The tool role takes no multipart content, so its images ride in a user
  // message rather than being dropped.
  const wire = await serializeMessagesWithImages([{
    role: 'user',
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'image', attachment: REF }] }],
  }], store())

  assert.equal(wire[0].role, 'tool')
  assert.equal(wire[0].content, '(see attached image)')
  assert.equal(wire[1].role, 'user')
  assert.equal(wire[1].content[1].type, 'image_url')
})

test('the catalog states image capability per model', async () => {
  const adapter = createAdapter({
    config: resolveConfig(),
    resolveApiKey: () => Promise.resolve('k'),
    resolveAttachments: () => store(),
  })
  const openai = await adapter.listModels('cliproxy-openai')

  assert.deepEqual(openai.find(m => m.id === 'gpt-5.5').inputModalities, ['text', 'image'])
  assert.deepEqual(openai.find(m => m.id === 'gpt-5.3-codex-spark').inputModalities, ['text'])
})

test('resolveModel reports the same capability the composer gates on', async () => {
  const adapter = createAdapter({
    config: resolveConfig(),
    resolveApiKey: () => Promise.resolve('k'),
    resolveAttachments: () => store(),
  })

  const vision = await adapter.resolveModel('cliproxy-claude', 'claude-opus-5')
  const textOnly = await adapter.resolveModel('cliproxy-openai', 'gpt-5.3-codex-spark')

  assert.deepEqual(vision.inputModalities, ['text', 'image'])
  assert.deepEqual(textOnly.inputModalities, ['text'])
})

test('a configured catalog must declare only supported modalities', () => {
  assert.throws(
    () => resolveConfig({ geminiModels: [{ id: 'm', inputModalities: ['text', 'audio'] }] }),
    /must contain only text and image/,
  )
  assert.throws(
    () => resolveConfig({ geminiModels: [{ id: 'm', inputModalities: ['image'] }] }),
    /must include "text"/,
  )
  assert.throws(
    () => resolveConfig({ geminiModels: [{ id: 'm', inputModalities: [] }] }),
    /must be a non-empty array/,
  )
})

test('a configured model without modalities defaults to text only', () => {
  // Under-claiming refuses an image the operator can see; over-claiming
  // strands a durable message the session cannot retry.
  const config = resolveConfig({ geminiModels: [{ id: 'm' }] })

  assert.deepEqual(config.routes.find(r => r.provider === 'cliproxy-gemini').models[0].inputModalities, ['text'])
})
