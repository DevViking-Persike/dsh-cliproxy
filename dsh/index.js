// dsh-cliproxy — DeepSeek Harness plugin: routes `cliproxy-claude`,
// `cliproxy-openai`, and `cliproxy-gemini` through one local CLIProxyAPI
// instance. The Gemini route uses the operator's Google Antigravity OAuth
// account; CLIProxyAPI owns those tokens and this plugin never reads them.
//
// Plain JavaScript with no build step and no dependency on any harness
// package: the adapter is a plain object, because `registerAdapter` validates
// the metadata it returns rather than the class it came from.
//
// Connection facts resolve per request, not at load, so a changed endpoint or
// a rotated key reaches the next call without a restart, while an in-flight
// stream keeps what it started with.

const { readFile } = require('node:fs/promises')
const { createAdapter } = require('./adapter.js')
const { resolveConfig } = require('./config.js')
const { CliProxyError } = require('./errors.js')
const { translate, DONE } = require('./translate.js')

/**
 * The chunk field names the harness assembler reads.
 *
 * This plugin lives outside the harness repository, which states it makes no
 * compatibility promise before its first release. A renamed field here does
 * not throw anywhere: `argumentsDelta` becoming `arguments` would append the
 * string "undefined" to every tool call, and nothing would report it. So the
 * vocabulary is checked once at load against a fixed payload, and a mismatch
 * refuses to mount rather than corrupting output silently.
 */
const EXPECTED_CHUNK_KEYS = {
  'block-start': ['type', 'index', 'blockType'],
  'text-delta': ['type', 'index', 'text'],
  'tool-call-delta': ['type', 'index', 'id', 'name', 'argumentsDelta'],
  'block-end': ['type', 'index', 'block'],
  usage: ['type', 'usage'],
  finish: ['type', 'reason'],
}

/**
 * Prove the emitted chunk vocabulary still matches what this plugin was
 * written against.
 *
 * @throws {Error} when a chunk type or field set has drifted.
 */
async function assertChunkVocabulary() {
  async function* payloads() {
    yield '{"choices":[{"delta":{"content":"x"}}]}'
    yield '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"f","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}'
    yield '{"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}'
    yield DONE
  }
  const seen = new Map()
  for await (const chunk of translate(payloads())) {
    if (!seen.has(chunk.type)) seen.set(chunk.type, Object.keys(chunk).sort())
  }
  for (const [type, keys] of Object.entries(EXPECTED_CHUNK_KEYS)) {
    const actual = seen.get(type)
    if (actual === undefined) {
      throw new Error(`dsh-cliproxy: this harness no longer emits "${type}" chunks; the plugin needs updating`)
    }
    const expected = [...keys].sort()
    if (actual.join(',') !== expected.join(',')) {
      throw new Error(
        `dsh-cliproxy: "${type}" chunk fields changed (expected ${expected.join(',')}, got ${actual.join(',')}); `
        + 'the plugin needs updating before it can be trusted',
      )
    }
  }
}

/**
 * Read the proxy API key for one request.
 *
 * The credential seam is preferred and the launch environment is the
 * fallback, matching how the harness resolves its own provider keys. The key
 * is read per request so a rotation takes effect on the next call, and its
 * text never enters an error message.
 *
 * @param {object} ctx - the Cordis context.
 * @param {object} config - the resolved plugin configuration.
 * @returns {Promise<string>} the key.
 */
async function readApiKey(ctx, config) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve({ kind: 'env', name: config.apiKeyEnv })
      if (typeof resolved === 'string' && resolved.trim().length > 0) return assertUsable(resolved, config)
    } catch {
      // A credential seam that cannot answer is not an error yet: the launch
      // environment below may still carry the key.
    }
  }
  const environment = ctx.get('launchEnvironment')?.env ?? process.env
  const value = environment[config.apiKeyEnv]
  if (typeof value === 'string' && value.trim().length > 0) return assertUsable(value, config)

  // A loopback proxy already owns an access key in its local config. Reading
  // that key is safe only when the destination is loopback: against a remote
  // URL, silently reusing a local key would send it to another machine. The
  // parser accepts only the ordinary YAML list form used by CLIProxyAPI and
  // never includes the key text in an error.
  const host = new URL(config.baseURL).hostname
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (config.readLocalProxyKey && loopback) {
    const local = await readFirstApiKey(config.proxyConfigPath)
    if (local !== undefined) return assertUsable(local, config)
  }

  throw new CliProxyError(
    `no CLIProxyAPI access key: set ${config.apiKeyEnv}, use the credential store, or configure proxyConfigPath for the local proxy`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * Read the first CLIProxyAPI access key from its local YAML config.
 *
 * The parser deliberately recognizes only the documented block-list form and
 * returns no other config value. A missing or unreadable file falls through to
 * the ordinary missing-credential error without exposing its contents.
 *
 * @param {string} filename - CLIProxyAPI config path.
 * @returns {Promise<string|undefined>} one access key, when configured.
 */
async function readFirstApiKey(filename) {
  let text
  try {
    text = await readFile(filename, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^api-keys:\s*(?:#.*)?$/.test(line))
  if (start < 0) return undefined
  for (const line of lines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break
    const match = line.match(/^\s+-\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/)
    if (match !== null && match[1].length > 0) return match[1]
  }
  return undefined
}

/**
 * Reject a key that cannot be sent as an HTTP header value.
 *
 * A key with whitespace or a non-ASCII character makes `fetch` throw an
 * opaque header error; naming the reference is more useful, and the key text
 * itself never appears in the message.
 *
 * @param {string} value - the raw key.
 * @param {object} config - the resolved configuration.
 * @returns {string} the trimmed key.
 */
function assertUsable(value, config) {
  const trimmed = value.trim()
  if (!/^[\x21-\x7E]+$/.test(trimmed)) {
    throw new CliProxyError(
      `the CLIProxyAPI key in ${config.apiKeyEnv} contains characters that cannot be sent in a header`,
      'INVALID_CREDENTIAL',
    )
  }
  return trimmed
}

module.exports = {
  name: 'dsh-cliproxy',
  inject: ['llm'],
  async apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig)
    // Both checks run before anything is registered, so a drifted harness or a
    // bad config fails where the operator is looking rather than on the first
    // model call.
    await assertChunkVocabulary()

    const adapter = createAdapter({
      config,
      resolveApiKey: () => readApiKey(ctx, config),
      // Optional and resolved per request: a deployment without the attachment
      // service still serves every text route, and mounting that service later
      // starts image input without a restart.
      resolveAttachments: () => ctx.get('attachments'),
    })

    ctx.effect(
      () => ctx.llm.registerAdapter(config.routes.map(route => route.provider), adapter),
      'dsh-cliproxy: provider routes',
    )
  },
}

module.exports.readFirstApiKey = readFirstApiKey
