// Wire-to-harness chunk translation.
//
// This is the highest-risk file in the plugin: every field name here is read
// structurally by the harness's block assembler, and a wrong one produces
// output that looks fine and is silently wrong. Two in particular:
//
//   - `argumentsDelta` (not `arguments`) on a tool-call delta. The assembler
//     appends it directly, so a wrong name appends the string "undefined" to
//     every tool call without raising anything.
//   - `inputTokens` excludes cache reads. The wire reports cached tokens
//     inside `prompt_tokens`; passing the raw number double-counts them in
//     every cost display, and nothing errors.
//
// The block-end object uses `arguments` while the delta uses `argumentsDelta`.
// Both spellings are correct in their own place.

const { CliProxyError } = require('./errors.js')

/**
 * The sentinel the SSE reader yields for the stream terminator. It is the
 * literal wire text, matching the in-tree adapter: the reader never emits a
 * `[DONE]` payload as data, so the value cannot collide with content.
 */
const DONE = '[DONE]'

/** Code the harness treats as retryable when a model completes with no content. */
const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

/**
 * Map a wire `finish_reason` onto the harness's tagged finish reason.
 * @param {string} reason - the wire value.
 * @returns {object} the tagged reason.
 */
function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter and any future value: surfaced as an error finish
      // carrying the raw word, rather than being flattened into `stop`.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage onto the harness convention of disjoint counts.
 * @param {object} usage - wire usage.
 * @returns {object} harness token usage.
 */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * Close one open block into the complete content block a `block-end` carries.
 * @param {object} block - the accumulated open block.
 * @returns {object} the content block.
 */
function closeBlock(block) {
  if (block.kind === 'text') return { type: 'text', text: block.text }
  if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text }
  return {
    type: 'tool-call',
    id: block.callId ?? '',
    name: block.name ?? '',
    arguments: block.text,
  }
}

/**
 * Translate SSE payloads into harness stream chunks.
 *
 * Emission discipline, matching the in-tree adapter exactly:
 *   1. A block opens lazily on its first NON-EMPTY delta, so a leading
 *      `reasoning_content: ""` opens nothing.
 *   2. One monotonic index is shared by text, reasoning, and tool calls, and
 *      reasoning is checked before text so an interleaving model gets index 0.
 *   3. On `[DONE]` and only then: every `block-end` in first-open order, then
 *      `usage` if any, then `finish`. Nothing follows `finish`.
 *   4. A `stop` finish with zero opened blocks becomes an EMPTY_RESPONSE error
 *      finish, which the harness treats as retryable.
 *   5. Payloads ending without `[DONE]` throw, so a truncated response can
 *      never be mistaken for a complete one.
 *
 * @param {AsyncIterable<string | symbol>} payloads - SSE data payloads.
 * @returns {AsyncGenerator<object>} harness stream chunks.
 */
async function* translate(payloads) {
  /** @type {{kind: string, index: number, text: string, callId?: string, name?: string}[]} */
  const order = []
  const toolBlocks = new Map()
  let textBlock
  let reasoningBlock
  let nextIndex = 0
  let pendingFinish
  let pendingUsage

  const open = (kind) => {
    const block = { kind, index: nextIndex++, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new CliProxyError(`malformed SSE payload: ${String(payload).slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (block === undefined) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId ?? '',
          ...block.name === undefined ? {} : { name: block.name },
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage arrives either on the finish chunk or as a trailing usage-only
    // chunk; the latest wins.
    if (chunk.usage !== undefined && chunk.usage !== null) pendingUsage = mapUsage(chunk.usage)
  }

  throw new CliProxyError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

module.exports = { DONE, EMPTY_RESPONSE_CODE, mapFinishReason, mapUsage, translate }
