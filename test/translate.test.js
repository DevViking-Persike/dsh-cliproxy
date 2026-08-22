// Chunk vocabulary, checked against output recorded from the harness's own
// translator rather than against this port's idea of it.
//
// `expected-chunks.json` was produced by running
// packages/llm/llm-cliproxy/src/translate.ts over these exact payloads. A
// field renamed on either side fails here instead of silently corrupting a
// tool call or double-counting cached tokens in production.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { DONE, translate } = require('../dsh/translate.js')

const EXPECTED = JSON.parse(readFileSync(join(__dirname, 'expected-chunks.json'), 'utf8'))

const FIXTURES = {
  'texto simples': [
    '{"choices":[{"delta":{"content":"Hel"}}]}',
    '{"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
  ],
  'reasoning vazio nao abre bloco': [
    '{"choices":[{"delta":{"reasoning_content":""}}]}',
    '{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}',
  ],
  'reasoning antes de texto': [
    '{"choices":[{"delta":{"reasoning_content":"pensando"}}]}',
    '{"choices":[{"delta":{"content":"resposta"},"finish_reason":"stop"}]}',
  ],
  'tool call fragmentado': [
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
  ],
  'usage disjunto': [
    '{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}',
    '{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":40}}}',
  ],
  'sem conteudo vira EMPTY_RESPONSE': ['{"choices":[{"delta":{},"finish_reason":"stop"}]}'],
  'content_filter': ['{"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}'],
}

/** Run the port over one fixture's payloads. */
async function run(payloads) {
  async function* source() {
    for (const payload of payloads) yield payload
    yield DONE
  }
  const chunks = []
  for await (const chunk of translate(source())) chunks.push(chunk)
  return chunks
}

for (const [label, payloads] of Object.entries(FIXTURES)) {
  test(`matches the harness translator: ${label}`, async () => {
    assert.deepEqual(await run(payloads), EXPECTED[label])
  })
}

test('a tool-call delta carries argumentsDelta, never arguments', async () => {
  // The assembler appends this field directly; the wrong name would append
  // the string "undefined" to every tool call and raise nothing.
  const deltas = (await run(FIXTURES['tool call fragmentado'])).filter(c => c.type === 'tool-call-delta')

  assert.ok(deltas.length > 0)
  for (const delta of deltas) {
    assert.ok(Object.hasOwn(delta, 'argumentsDelta'), 'missing argumentsDelta')
    assert.equal(Object.hasOwn(delta, 'arguments'), false, 'delta must not carry `arguments`')
    assert.equal(typeof delta.id, 'string')
  }
})

test('the closed tool-call block carries arguments, never argumentsDelta', async () => {
  const end = (await run(FIXTURES['tool call fragmentado'])).find(c => c.type === 'block-end')

  assert.equal(end.block.arguments, '{"a":1}')
  assert.equal(Object.hasOwn(end.block, 'argumentsDelta'), false)
})

test('usage counts are disjoint, so cache reads are not double counted', async () => {
  const usage = (await run(FIXTURES['usage disjunto'])).find(c => c.type === 'usage').usage

  // 100 prompt tokens of which 40 were cache hits: 60 are genuinely new.
  assert.equal(usage.inputTokens, 60)
  assert.equal(usage.cacheReadTokens, 40)
})

test('finish is always last, and nothing follows it', async () => {
  for (const payloads of Object.values(FIXTURES)) {
    const chunks = await run(payloads)
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(chunks.filter(c => c.type === 'finish').length, 1)
  }
})

test('a completed response with no content is a retryable error, not a stop', async () => {
  const finish = (await run(FIXTURES['sem conteudo vira EMPTY_RESPONSE'])).at(-1)

  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('malformed JSON throws instead of being skipped', async () => {
  await assert.rejects(run(['{nao-e-json']), err => err.code === 'MALFORMED_RESPONSE')
})

test('payloads ending without the terminator throw', async () => {
  // A truncated response must never be mistaken for a complete one.
  async function* truncated() {
    yield '{"choices":[{"delta":{"content":"x"}}]}'
  }
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of translate(truncated())) chunks.push(chunk)
  }, err => err.code === 'STREAM_CLOSED')
})
