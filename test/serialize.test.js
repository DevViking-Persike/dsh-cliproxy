// Wire-body serialization, checked against output recorded from the harness's
// own serializer (packages/llm/llm-cliproxy/src/serialize.ts) over the same
// inputs. A divergence fails here rather than reaching the endpoint as a
// subtly wrong request.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { serializeRequest } = require('../dsh/serialize.js')

const EXPECTED = JSON.parse(readFileSync(join(__dirname, 'expected-requests.json'), 'utf8'))

const CASES = {
  'texto simples': { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] },
  'com system': { model: 'm', system: 'seja breve', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] },
  'assistant sem texto': { model: 'm', messages: [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }] },
  ] },
  'tool result vazio': { model: 'm', messages: [
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] },
  ] },
  'com ferramentas': { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }] },
  'maxTokens explicito': { model: 'm', maxTokens: 99, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
}

for (const [label, options] of Object.entries(CASES)) {
  test(`matches the harness serializer: ${label}`, () => {
    assert.deepEqual(serializeRequest(options, { maxTokens: 4096 }), EXPECTED[label])
  })
}

test('a text-less assistant turn sends empty content, never null', () => {
  // A null here is rejected by several gateways, and the harness replays this
  // shape on every tool-call-only turn — one null would brick the session.
  const body = serializeRequest(CASES['assistant sem texto'], {})

  assert.equal(body.messages[0].content, '')
  assert.notEqual(body.messages[0].content, null)
})

test('an empty tool result still carries content on the wire', () => {
  const body = serializeRequest(CASES['tool result vazio'], {})
  const toolMessage = body.messages.find(m => m.role === 'tool')

  assert.equal(toolMessage.content, '(no output)')
})

test('usage is requested, or every turn reports zero tokens', () => {
  assert.deepEqual(serializeRequest(CASES['texto simples'], {}).stream_options, { include_usage: true })
})

test('an explicit request cap wins over the configured default', () => {
  assert.equal(serializeRequest(CASES['maxTokens explicito'], { maxTokens: 4096 }).max_tokens, 99)
})

test('image content is refused before it can be silently dropped', () => {
  assert.throws(
    () => serializeRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/png' }] },
    ] }, {}),
    err => err.code === 'UNSUPPORTED_CONTENT',
  )
})

test('an image nested inside a tool result is refused too', () => {
  // The flattening path only reads text blocks, so a nested image would
  // vanish without this check.
  assert.throws(
    () => serializeRequest({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [
        { type: 'image', data: 'x', mediaType: 'image/png' },
      ] }] },
    ] }, {}),
    err => err.code === 'UNSUPPORTED_CONTENT',
  )
})
