// SSE decoding for the CLIProxyAPI transport.
//
// Framing — chunk reassembly, UTF-8 and CRLF handling, BOM, comment and
// non-data field skipping, multi-`data:` joining — belongs to
// `eventsource-parser`; reimplementing it by hand is how mid-UTF-8 splits
// become corrupted text. This module keeps only the protocol rule: the
// literal `[DONE]` is yielded so the caller owns final flushing, and a stream
// that ends without it raises rather than looking complete.

const { EventSourceParserStream } = require('eventsource-parser/stream')
const { CliProxyError } = require('./errors.js')
const { DONE } = require('./translate.js')

/**
 * Parse an SSE byte stream into data payloads.
 *
 * @param {ReadableStream} stream - raw SSE bytes; reads may split anywhere.
 * @param {(comment: string) => void} [onComment] - transport-activity callback;
 *   comments never enter the yielded payload stream.
 * @returns {AsyncGenerator<string>} data payloads in arrival order, `[DONE]` last.
 */
async function* parseSse(stream, onComment) {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new CliProxyError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

module.exports = { parseSse }
