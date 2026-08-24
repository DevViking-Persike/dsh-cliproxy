// Harness messages to CLIProxyAPI chat-completions requests.
//
// Text and image input. An image block is a durable attachment reference, not
// bytes: the adapter resolves it through the harness attachment service and
// sends a transient `data:` URL, so the session log keeps the reference and
// the request carries the pixels.
//
// A model whose catalog entry does not declare image input is refused before
// serialization. Silently flattening an image away is worse than refusing it:
// the model would answer a question it never saw.

const { CliProxyError } = require('./errors.js')

/** Media types the wire accepts as a data URL. */
const SUPPORTED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

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
      'This CLIProxyAPI model does not accept image input.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * Reject an image in a role whose wire format cannot carry one.
 *
 * Only user messages take multipart content on this protocol; an image in
 * system or assistant history would be dropped by the string path below, and
 * it stays in the durable log, so every later turn would drop it again.
 *
 * @param {readonly object[]} messages - the harness conversation.
 */
function assertImageRoles(messages) {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new CliProxyError(
        `This adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/**
 * Resolve one durable image reference into its transient wire part.
 *
 * @param {object} block - the harness image block.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the `image_url` wire part.
 */
async function imagePart(block, attachments, signal) {
  let stored
  try {
    stored = await attachments.readImage(block.attachment, signal)
  } catch (error) {
    // The attachment service owns admission; its refusal is the accurate
    // message, and reporting it as a transport fault would send the operator
    // looking at the network.
    throw new CliProxyError(
      error?.message ?? 'the attachment could not be read',
      error?.code ?? 'UNSUPPORTED_CONTENT',
      { cause: error },
    )
  }
  const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType
  if (!SUPPORTED_MEDIA_TYPES.includes(mediaType)) {
    throw new CliProxyError(
      `unsupported image media type "${String(mediaType)}"`,
      'UNSUPPORTED_CONTENT',
    )
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${Buffer.from(stored.data).toString('base64')}` },
  }
}

/**
 * Convert user or nested tool-result blocks into ordered wire parts.
 *
 * Order is preserved because it carries meaning: text before an image reads
 * as an instruction about it, and text after reads as a follow-up.
 *
 * @param {readonly object[]} blocks - message content blocks.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object[]>} ordered wire parts.
 */
async function contentParts(blocks, attachments, signal) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block, attachments, signal))
    } else if (block.type === 'tool-result' && Array.isArray(block.content)) {
      parts.push(...await contentParts(block.content, attachments, signal))
    }
    // Other merge-extensible blocks are not user-input vocabulary here.
  }
  return parts
}

/**
 * Keep a text-only user message on the compact string form.
 *
 * Gateways differ in how they handle a single-element array, and the string
 * form is what every one of them has always accepted.
 *
 * @param {readonly object[]} parts - ordered wire parts.
 * @returns {string|object[]} the wire content.
 */
function userContent(parts) {
  const text = []
  for (const part of parts) {
    if (part.type === 'image_url') return [...parts]
    text.push(part.text)
  }
  return text.join('')
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
 * Serialize the conversation, text only.
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
 * Serialize the conversation with image resolution.
 *
 * A tool result stays a string `tool` message, since the role takes no
 * multipart content; its images follow in a user message so the model still
 * sees them.
 *
 * @param {readonly object[]} messages - the harness conversation, in order.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object[]>} the wire messages.
 */
async function serializeMessagesWithImages(messages, attachments, signal) {
  assertImageRoles(messages)
  const wire = []
  const pendingToolImages = []

  /** Flush tool-result images before anything that is not another tool result. */
  const flushToolImages = () => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: 'Attached image(s) from tool result:' }, ...pendingToolImages],
    })
    pendingToolImages.length = 0
  }

  for (const message of messages) {
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const ownBlocks = message.content.filter(block => block.type !== 'tool-result')
    const parts = await contentParts(ownBlocks, attachments, signal)
    if (parts.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: userContent(parts) })
    }
    for (const result of toolResults) {
      const resultParts = await contentParts(result.content, attachments, signal)
      const text = resultParts.filter(part => part.type === 'text').map(part => part.text).join('')
      const images = resultParts.filter(part => part.type === 'image_url')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || (images.length > 0 ? '(see attached image)' : '(no output)'),
      })
      pendingToolImages.push(...images)
    }
  }
  flushToolImages()
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
 * Assemble the request fields shared by the text-only and image paths.
 * @param {object} options - the harness generation request.
 * @param {object[]} messages - the already-serialized wire messages.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @returns {object} the chat-completions body.
 */
function assembleRequest(options, messages, defaults) {
  const explicitMaxTokens = options.maxTokens ?? defaults.maxTokens
  return {
    model: options.model,
    messages: options.system === undefined
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

/**
 * Serialize one complete text-only streaming request.
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @returns {object} the chat-completions body.
 */
function serializeRequest(options, defaults) {
  return assembleRequest(options, serializeMessages(options.messages), defaults)
}

/**
 * Serialize one complete streaming request with image resolution.
 * @param {object} options - the harness generation request.
 * @param {{maxTokens?: number}} defaults - adapter-level defaults.
 * @param {object} attachments - the harness attachment service.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the chat-completions body.
 */
async function serializeRequestWithImages(options, defaults, attachments, signal) {
  const messages = await serializeMessagesWithImages(options.messages, attachments, signal)
  return assembleRequest(options, messages, defaults)
}

module.exports = {
  SUPPORTED_MEDIA_TYPES,
  contentHasImage,
  serializeMessages,
  serializeMessagesWithImages,
  serializeRequest,
  serializeRequestWithImages,
  toJsonSchema,
}
