// Plugin configuration.
//
// Validation is by hand rather than through a schema library, so the plugin
// carries no dependency the harness would otherwise supply. Every bound is
// checked at load: a misconfiguration is self-contained, so it must fail where
// the operator can see it, not on the first model call hours later.

/** Idle budget between stream reads before the transport gives up. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Context window assumed for a model absent from the catalog. */
const DEFAULT_CONTEXT_WINDOW = 200_000
/** Output cap applied when neither the request nor the catalog states one. */
const DEFAULT_MAX_TOKENS = 32_000
/** Node's largest usable timer delay; a longer one fires immediately. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Modalities a catalog entry may declare.
 *
 * Only image is added here. Several Gemini models accept audio and video
 * upstream, but this serializer resolves neither, and declaring a modality
 * the adapter cannot send would admit input it then drops.
 */
const MODEL_MODALITIES = ['text', 'image']

/** Text and image, for the models whose vendor documents image input. */
const VISION = ['text', 'image']

/**
 * Claude models CLIProxyAPI exposes, when the operator configures none.
 *
 * Every entry here takes image input, per CLIProxyAPI's own model registry.
 */
const DEFAULT_CLAUDE_MODELS = [
  { id: 'claude-fable-5', name: 'Claude Fable 5 (CLIProxyAPI)', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-opus-5', name: 'Claude Opus 5 (CLIProxyAPI)', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 (CLIProxyAPI)', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 (CLIProxyAPI)', contextWindow: 1_000_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (CLIProxyAPI)', contextWindow: 200_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 (CLIProxyAPI)', contextWindow: 200_000, maxTokens: 64_000, inputModalities: VISION },
]

/**
 * OpenAI models CLIProxyAPI exposes, when the operator configures none.
 *
 * `gpt-5.3-codex-spark` is text-only in that registry while every other entry
 * takes images, so it keeps the default and is the reason modality is declared
 * per model rather than per route.
 */
const DEFAULT_OPENAI_MODELS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (CLIProxyAPI)', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (CLIProxyAPI)', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (CLIProxyAPI)', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.5', name: 'GPT-5.5 (CLIProxyAPI)', contextWindow: 400_000, maxTokens: 128_000, inputModalities: VISION },
  { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark (CLIProxyAPI)', contextWindow: 400_000, maxTokens: 128_000 },
]

/** Gemini models Antigravity exposes through CLIProxyAPI. */
const DEFAULT_GEMINI_MODELS = [
  { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_536, inputModalities: VISION },
  { id: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_536, inputModalities: VISION },
  { id: 'gemini-pro-agent', name: 'Gemini 3.1 Pro High (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_535, inputModalities: VISION },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro Low (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_535, inputModalities: VISION },
  { id: 'gemini-3-flash-agent', name: 'Gemini 3.5 Flash High (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_536, inputModalities: VISION },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash Medium (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_535, inputModalities: VISION },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_536, inputModalities: VISION },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite (Antigravity)', contextWindow: 1_048_576, maxTokens: 65_535, inputModalities: VISION },
]

/** The default retry policy, matching the harness's own normal-mode defaults. */
const DEFAULT_RETRY_POLICY = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'EMPTY_RESPONSE', 'STREAM_CLOSED'],
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
}

/**
 * Require a positive integer within the timer-safe range.
 * @param {unknown} value - the configured value.
 * @param {string} field - field name, for the message.
 * @param {number} fallback - value used when unset.
 * @returns {number}
 */
function positiveInteger(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`dsh-cliproxy: ${field} must be a positive integer`)
  }
  if (value > MAX_TIMER_DELAY_MS) {
    throw new Error(`dsh-cliproxy: ${field} must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return value
}

/**
 * Validate one configured model catalog.
 * @param {unknown} value - the configured array.
 * @param {string} field - field name, for the message.
 * @param {object[]} fallback - catalog used when unset.
 * @returns {object[]}
 */
function catalog(value, field, fallback) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`dsh-cliproxy: ${field} must be a non-empty array`)
  }
  const seen = new Set()
  return value.map((entry, at) => {
    const where = `${field}[${String(at)}]`
    if (typeof entry?.id !== 'string' || entry.id.length === 0) {
      throw new Error(`dsh-cliproxy: ${where}.id must be a non-empty string`)
    }
    if (seen.has(entry.id)) throw new Error(`dsh-cliproxy: ${where}.id "${entry.id}" is duplicated`)
    seen.add(entry.id)
    return {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      contextWindow: positiveInteger(entry.contextWindow, `${where}.contextWindow`, DEFAULT_CONTEXT_WINDOW),
      maxTokens: positiveInteger(entry.maxTokens, `${where}.maxTokens`, DEFAULT_MAX_TOKENS),
      inputModalities: Object.freeze(modalities(entry.inputModalities, `${where}.inputModalities`)),
    }
  })
}

/**
 * Validate one entry's declared input modalities.
 *
 * The default is text alone, and that asymmetry is deliberate: the two wrong
 * answers do not cost the same. Under-claiming refuses an image before it is
 * attached, which the operator sees immediately. Over-claiming admits an image
 * the endpoint then rejects — after the message is durable, so the session
 * repeats a request that cannot succeed and no model choice recovers it.
 *
 * @param {unknown} value - the configured array.
 * @param {string} field - field name, for the message.
 * @returns {string[]} the validated modalities.
 */
function modalities(value, field) {
  if (value === undefined) return ['text']
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`dsh-cliproxy: ${field} must be a non-empty array`)
  }
  const seen = new Set()
  for (const modality of value) {
    if (!MODEL_MODALITIES.includes(modality)) {
      throw new Error(`dsh-cliproxy: ${field} must contain only ${MODEL_MODALITIES.join(' and ')}`)
    }
    if (seen.has(modality)) throw new Error(`dsh-cliproxy: ${field} must not contain duplicates`)
    seen.add(modality)
  }
  if (!seen.has('text')) throw new Error(`dsh-cliproxy: ${field} must include "text"`)
  return [...value]
}

/**
 * Resolve and validate the plugin configuration.
 *
 * A supplied catalog replaces the default rather than merging with it: an
 * operator naming three models means those three, and a merge would silently
 * reintroduce models their proxy does not serve.
 *
 * @param {object} [raw] - the cordis.yml entry config.
 * @returns {object} the frozen resolved configuration.
 */
function resolveConfig(raw = {}) {
  const baseURL = (raw.baseURL ?? 'http://127.0.0.1:8317/v1').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseURL)) {
    throw new Error('dsh-cliproxy: baseURL must be an http(s) URL')
  }
  const retryPolicy = raw.retryPolicy === undefined
    ? DEFAULT_RETRY_POLICY
    : { ...DEFAULT_RETRY_POLICY, ...raw.retryPolicy }

  return Object.freeze({
    baseURL,
    apiKeyEnv: raw.apiKeyEnv ?? 'CLIPROXY_API_KEY',
    proxyConfigPath: raw.proxyConfigPath ?? '/opt/homebrew/etc/cliproxyapi.conf',
    readLocalProxyKey: raw.readLocalProxyKey ?? true,
    streamIdleTimeoutMs: positiveInteger(raw.streamIdleTimeoutMs, 'streamIdleTimeoutMs', DEFAULT_STREAM_IDLE_TIMEOUT_MS),
    defaultContextWindow: positiveInteger(raw.defaultContextWindow, 'defaultContextWindow', DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInteger(raw.maxTokens, 'maxTokens', DEFAULT_MAX_TOKENS),
    retryPolicy: Object.freeze(retryPolicy),
    routes: Object.freeze([
      Object.freeze({
        provider: 'cliproxy-claude',
        displayName: 'CLIProxyAPI (Claude)',
        models: Object.freeze(catalog(raw.claudeModels, 'claudeModels', DEFAULT_CLAUDE_MODELS)),
      }),
      Object.freeze({
        provider: 'cliproxy-openai',
        displayName: 'CLIProxyAPI (OpenAI)',
        models: Object.freeze(catalog(raw.openaiModels, 'openaiModels', DEFAULT_OPENAI_MODELS)),
      }),
      Object.freeze({
        provider: 'cliproxy-gemini',
        displayName: 'Gemini (Antigravity subscription)',
        models: Object.freeze(catalog(raw.geminiModels, 'geminiModels', DEFAULT_GEMINI_MODELS)),
      }),
    ]),
  })
}

module.exports = {
  DEFAULT_CLAUDE_MODELS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_GEMINI_MODELS,
  MODEL_MODALITIES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OPENAI_MODELS,
  DEFAULT_RETRY_POLICY,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
  resolveConfig,
}
