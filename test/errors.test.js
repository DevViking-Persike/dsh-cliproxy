// The failure vocabulary that crosses the package boundary.
//
// The fixtures below were produced by running the harness's own classifiers
// (packages/llm/llm/src/error.ts) and recording their answers, so a drift in
// this port fails here rather than turning a recoverable overflow into an
// unrecoverable-looking INVALID_REQUEST in production.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CliProxyError, httpErrorCode, isContextWindowExceeded, isQuotaExceeded, retryAfterMs } = require('../dsh/errors.js')

test('context-overflow wording matches the harness classifier', () => {
  for (const [text, expected] of [
    ['maximum context length is 8192', true],
    ['request too large for this model context', true],
    ['prompt exceeds the model context window', true],
    ['string aleatoria', false],
  ]) {
    assert.equal(isContextWindowExceeded(text), expected, text)
  }
})

test('quota wording matches the harness classifier', () => {
  for (const [text, expected] of [
    ['insufficient quota', true],
    ['insufficient balance', true],
    ['you exceeded your current quota', true],
    ['string aleatoria', false],
  ]) {
    assert.equal(isQuotaExceeded(text), expected, text)
  }
})

test('status codes map onto the harness vocabulary', () => {
  assert.equal(httpErrorCode(401, ''), 'AUTH')
  assert.equal(httpErrorCode(403, ''), 'AUTH')
  assert.equal(httpErrorCode(429, ''), 'RATE_LIMIT')
  assert.equal(httpErrorCode(413, ''), 'INVALID_REQUEST')
  assert.equal(httpErrorCode(500, ''), 'SERVER')
  assert.equal(httpErrorCode(503, ''), 'SERVER')
})

test('a 400 is read from its message, not its status alone', () => {
  // The distinction that matters: one of these the caller can recover from by
  // compacting, and the other it cannot.
  assert.equal(httpErrorCode(400, 'maximum context length is 8192'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(httpErrorCode(400, 'insufficient quota'), 'QUOTA')
  assert.equal(httpErrorCode(400, 'missing field model'), 'INVALID_REQUEST')
})

test('an unmapped status keeps its number instead of being folded into SERVER', () => {
  assert.equal(httpErrorCode(418, ''), 'HTTP_418')
})

test('the failure object carries the fields the retry plugin reads', () => {
  const error = new CliProxyError('rate limited', 'RATE_LIMIT', { status: 429, providerRetryAfterMs: 2000 })

  // These four names are the contract; the retry plugin reads them structurally.
  assert.deepEqual(error.failure, {
    message: 'rate limited',
    code: 'RATE_LIMIT',
    status: 429,
    providerRetryAfterMs: 2000,
  })
  assert.equal(error.code, 'RATE_LIMIT')
})

test('the failure object omits absent fields rather than nulling them', () => {
  assert.deepEqual(new CliProxyError('boom', 'SERVER').failure, { message: 'boom', code: 'SERVER' })
})

test('the failure survives being thrown and caught', () => {
  // An own property, not a prototype getter: the harness receives this across
  // a package boundary and reads it off the caught value.
  try {
    throw new CliProxyError('x', 'AUTH', { status: 401 })
  } catch (error) {
    assert.equal(Object.hasOwn(error, 'failure'), true)
    assert.equal(error.failure.status, 401)
  }
})

test('retry-after is read in both RFC 9110 forms', () => {
  assert.equal(retryAfterMs('2'), 2000)
  assert.equal(retryAfterMs(' 30 '), 30000)
  assert.equal(retryAfterMs(null), undefined)
  assert.equal(retryAfterMs('not-a-date'), undefined)
})

test('a retry-after date in the past yields no delay rather than a negative one', () => {
  assert.equal(retryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0)
})

test('a retry-after date in the future yields its distance', () => {
  const ms = retryAfterMs(new Date(Date.now() + 30_000).toUTCString())

  assert.ok(ms >= 28_000 && ms <= 30_000, `expected about 30s, got ${String(ms)}`)
})
