// dsh-cliproxy — DeepSeek Harness plugin: routes `cliproxy-claude` and
// `cliproxy-openai` through one local CLIProxyAPI instance, so the agent
// reaches the operator's own CLI subscriptions over an OpenAI-compatible
// endpoint.
//
// Plain JavaScript with no build step and no dependency on any harness
// package: the adapter is a plain object, because `registerAdapter` validates
// the metadata it returns rather than the class it came from.
//
// Connection facts resolve per request, not at load, so a changed endpoint or
// a rotated key reaches the next call without a restart, while an in-flight
// stream keeps what it started with.

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
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliProxyError(
      `no CLIProxyAPI key: set ${config.apiKeyEnv} in the environment or the credential store`,
      'MISSING_CREDENTIAL',
    )
  }
  return assertUsable(value, config)
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
    })

    ctx.effect(
      () => ctx.llm.registerAdapter(config.routes.map(route => route.provider), adapter),
      'dsh-cliproxy: provider routes',
    )
  },
}
