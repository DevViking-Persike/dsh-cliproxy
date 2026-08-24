// Tool parameters on the wire.
//
// The harness declares parameters as a bare property map. Claude and OpenAI
// accept that; the Gemini/Antigravity backend validates against protobuf
// Schema and rejects the request by naming the first property as an unknown
// field. These tests pin the wrapping that keeps one serializer for all three.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { serializeRequest, toJsonSchema } = require('../dsh/serialize.js')

const base = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }

test('a bare property map becomes a JSON Schema object', () => {
  const schema = toJsonSchema({ container: { type: 'string' }, tail: { type: 'number' } })

  assert.equal(schema.type, 'object')
  assert.deepEqual(Object.keys(schema.properties), ['container', 'tail'])
})

test('the per-property required flag moves into the sibling array', () => {
  // Left in place, it is itself rejected as an unknown field.
  const schema = toJsonSchema({ container: { type: 'string', required: true }, tail: { type: 'number' } })

  assert.deepEqual(schema.required, ['container'])
  assert.equal(Object.hasOwn(schema.properties.container, 'required'), false)
})

test('required is omitted entirely when no property demands it', () => {
  assert.equal(Object.hasOwn(toJsonSchema({ a: { type: 'string' } }), 'required'), false)
})

test('an already valid schema passes through untouched', () => {
  const declared = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }

  assert.equal(toJsonSchema(declared), declared)
})

test('a schema declaring only properties is left alone', () => {
  const declared = { properties: { a: { type: 'string' } } }

  assert.equal(toJsonSchema(declared), declared)
})

test('a tool with no parameters still sends a valid empty object', () => {
  // A bare {} would be rejected as a schema with no type.
  assert.deepEqual(toJsonSchema(undefined), { type: 'object', properties: {} })
  assert.deepEqual(toJsonSchema({}), { type: 'object', properties: {} })
})

test('the serialized request carries the wrapped schema', () => {
  const body = serializeRequest({
    ...base,
    tools: [{ name: 'docker_logs', description: 'd', parameters: { container: { type: 'string', required: true } } }],
  }, {})

  assert.equal(body.tools[0].function.parameters.type, 'object')
  assert.deepEqual(body.tools[0].function.parameters.required, ['container'])
})

test('every declared tool is wrapped, not just the first', () => {
  const body = serializeRequest({
    ...base,
    tools: [
      { name: 'a', description: 'd', parameters: { x: { type: 'string' } } },
      { name: 'b', description: 'd', parameters: { y: { type: 'number' } } },
    ],
  }, {})

  for (const tool of body.tools) assert.equal(tool.function.parameters.type, 'object')
})
