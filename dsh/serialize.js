// Harness messages to CLIProxyAPI chat-completions requests.
//
// Text-only: image content is rejected before serialization, because the
// flattening path below would erase it silently and the model would answer a
// question it never saw.

const { CliProxyError } = require('./errors.js')

/**
 * Whether any block in a message carries an image, including inside a tool
 * result. Ported from the harness helper rather than imported, since a
 * standalone plugin cannot depend on the harness package.
 *
 * @param {readonly object[]} blocks - message content blocks.
 * @returns {boolean}
 */
function contentHasImage(blocks) {
  return blocks.some(block => block.type === 'image'
    || (block.type === 'tool-result' && Array.isArray(block.content) && contentHasImage(block.content)))
}

/**
 * Join the text blocks of a message.
 * @param {readonly object[]} blocks - message content blocks.
 * @returns {string}
 */
function flattenText(blocks) {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Reject image content before any flattening path can erase it.
 * @param {readonly object[]} blocks - message content blocks.
 */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new CliProxyError(
      'The CLIProxyAPI chat-completions adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * Serialize one assistant message: text, reasoning, and tool calls.
 * @param {object} message - the harness message.
 * @returns {object} the wire message.
 */
function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "", never null. The harness replays empty content
    // on tool-call-only turns, several gateways reject a null, and a durably
    // logged session would then fail on every later turn.
    content: text,
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation.
 *
 * Tool results ride inside user messages in the harness vocabulary, but
 * chat-completions wants them as standalone `role: 'tool'` entries, so each
 * one is expanded after the user text it followed.
 *
 * @param {readonly object[]} messages - the harness conversation, in order.
 * @returns {object[]} the wire messages.
 */
function serializeMessages(messages) {
  const wire = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs some content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Present tool parameters as a JSON Schema object.
 *
 * The harness declares a tool's parameters as a bare property map, and the
 * Claude and OpenAI routes accept that. The Gemini/Antigravity backend
 * validates against protobuf `Schema` instead and rejects the whole request by
 * naming the first property as an unknown field — an error that reads like a
 * bad tool rather than a missing wrapper. Wrapping here keeps every route on
 * one serializer.
 *
 * A value already carrying `type` or `properties` is a real schema and passes
 * through, so a correctly declared tool is never rewritten.
 *
 * @param {object|undefined} parameters - declared tool parameters.
 * @returns {object} a JSON Schema object.
 */
function toJsonSchema(parameters) {
  if (parameters === undefined || parameters === null) return { type: 'object', properties: {} }
  if (typeof parameters !== 'object' || Array.isArray(parameters)) return { type: 'object', properties: {} }
  if (Object.hasOwn(parameters, 'type') || Object.hasOwn(parameters, 'properties')) return parameters

  const properties = {}
  const required = []
  for (const [name, declared] of Object.entries(parameters)) {
    if (declared === null || typeof declared !== 'object') continue
    // `required` is a per-property flag in the harness declaration and a
    // sibling array in JSON Schema; leaving it in place makes the backend
    // reject the property it describes.
    const { required: isRequired, ...rest } = declared
    properties[name] = rest
    if (isRequired === true) required.push(name)
  }
  return { type: 'object', properties, ...required.length === 0 ? {} : { required } }
}

/**
 * Serialize one complete streaming request.
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level request defaults.
 * @returns {object} the chat-completions body.
 */
function serializeRequest(options, defaults) {
  const messages = serializeMessages(options.messages)
  const explicitMaxTokens = options.maxTokens ?? defaults.maxTokens
  return {
    model: options.model,
    messages: options.system === undefined || options.system.length === 0
      ? messages
      : [{ role: 'system', content: options.system }, ...messages],
    stream: true,
    // Without this the endpoint omits usage entirely and every turn reports
    // zero tokens.
    stream_options: { include_usage: true },
    ...options.tools !== undefined && options.tools.length > 0
      ? {
        tools: options.tools.map(tool => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: toJsonSchema(tool.parameters),
          },
        })),
      }
      : {},
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...explicitMaxTokens === undefined ? {} : { max_tokens: explicitMaxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
  }
}

module.exports = { contentHasImage, serializeMessages, serializeRequest, toJsonSchema }
