// Available model ids come from the proxy's authenticated OpenAI catalog.

const { CliProxyError, httpErrorCode } = require('./errors.js')

/**
 * Discover models served by the proxy and attach configured capability metadata.
 * Unknown canonical ids are text-only; explicit catalogs restrict each route.
 * @param {object} config - resolved plugin configuration.
 * @param {object} route - selected provider route.
 * @param {string} apiKey - proxy access key, never a vendor credential.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object[]>} available models belonging to this route.
 */
async function discoverModels(config, route, apiKey, signal) {
  const timeout = AbortSignal.timeout(config.modelDiscoveryTimeoutMs)
  const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let payload
  try {
    const response = await fetch(`${config.baseURL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: requestSignal,
      redirect: 'error',
    })
    if (!response.ok) {
      // Proxy error bodies may echo credentials; catalog errors expose status only.
      await response.body?.cancel()
      throw new CliProxyError(`CLIProxyAPI model discovery responded ${response.status}`,
        httpErrorCode(response.status, ''), { status: response.status })
    }
    payload = await response.json()
  } catch (error) {
    if (signal?.aborted) throw new CliProxyError('Model discovery aborted by caller', 'ABORTED')
    if (timeout.aborted) throw new CliProxyError('CLIProxyAPI model discovery timed out', 'TIMEOUT')
    if (error instanceof CliProxyError) throw error
    throw new CliProxyError('CLIProxyAPI model discovery failed', 'TRANSPORT')
  }
  if (!Array.isArray(payload?.data)) {
    throw new CliProxyError('CLIProxyAPI model catalog must contain a data array', 'INVALID_RESPONSE')
  }
  const configured = new Map(route.models.map(model => [model.id, model]))
  const seen = new Set()
  const models = []
  for (const entry of payload.data) {
    if (typeof entry?.id !== 'string' || entry.id.trim().length === 0 || seen.has(entry.id)) {
      throw new CliProxyError('CLIProxyAPI model catalog contains an invalid or duplicate id', 'INVALID_RESPONSE')
    }
    seen.add(entry.id)
    const metadata = configured.get(entry.id)
    if (metadata !== undefined) models.push(metadata)
    else if (!route.catalogConfigured && entry.id.startsWith(route.modelPrefix)) {
      models.push({ id: entry.id, name: entry.id, inputModalities: ['text'] })
    }
  }
  return models
}

module.exports = { discoverModels }
