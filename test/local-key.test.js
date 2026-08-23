// Local proxy-key discovery: lets a loopback CLIProxyAPI authenticate DSH
// without turning its internal access key into a Gemini API key or environment
// variable.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { readFirstApiKey } = require('../dsh/index.js')

/** Write one scratch config. */
function config(text) {
  const dir = mkdtempSync(join(tmpdir(), 'cliproxy-config-'))
  const file = join(dir, 'config.yaml')
  writeFileSync(file, text)
  return file
}

test('reads the first key from the documented YAML block list', async () => {
  const file = config(`host: 127.0.0.1\napi-keys:\n  - local-one\n  - local-two\ndebug: false\n`)

  assert.equal(await readFirstApiKey(file), 'local-one')
})

test('accepts quoted keys and strips no secret characters', async () => {
  const file = config(`api-keys:\n  - "abc-DEF_123"\n`)

  assert.equal(await readFirstApiKey(file), 'abc-DEF_123')
})

test('returns undefined when the file is absent', async () => {
  assert.equal(await readFirstApiKey('/does/not/exist'), undefined)
})

test('returns undefined for an inline list it cannot safely parse', async () => {
  // Being narrow is intentional: guessing YAML risks reading an unrelated
  // config value as a key and sending it in Authorization.
  assert.equal(await readFirstApiKey(config('api-keys: [one, two]\n')), undefined)
})

test('stops at the next top-level field', async () => {
  const file = config(`api-keys:\ndebug: false\n  - not-a-key\n`)

  assert.equal(await readFirstApiKey(file), undefined)
})
