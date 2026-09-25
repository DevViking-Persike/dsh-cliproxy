// The adapter object registered on ctx.llm.
//
// A plain object, not a subclass: registerAdapter validates the metadata it
// gets back, never the identity of the class, so a standalone plugin can
// supply the same surface without importing the harness. What the registry
// does check is exact — providerInfo(p).id must equal p and .name must be
// non-empty — and a failure there rejects the whole registration.
//
// The base class this replaces supplies nothing we depend on: every method
// below is written out.

const { CliProxyError, httpErrorCode, retryAfterMs } = require('./errors.js')
const { parseSse } = require('./sse.js')
const { contentHasImage, serializeRequest, serializeRequestWithImages } = require('./serialize.js')
const { translate } = require('./translate.js')
const { discoverModels } = require('./models.js')

/**
 * A deadline that resets on activity rather than bounding the whole stream.
 *
 * A long generation is not a stuck one: the timer exists only while a read is
 * outstanding, so a model that thinks for ten minutes and then answers is
 * fine, while a connection that goes quiet is not.
 *
 * @param {AbortSignal} upstream - caller and consumer cancellation.
 * @param {number} idleMs - budget between reads.
 * @returns {{signal: AbortSignal, pulse: () => void, next: (it: AsyncIterator<unknown>) => Promise<IteratorResult<unknown>>, dispose: () => void}}
 */
function idleWatchdog(upstream, idleMs) {
  const controller = new AbortController()
  let timer
  let timedOut = false
  const onUpstream = () => { controller.abort(upstream.reason) }
  if (upstream.aborted) controller.abort(upstream.reason)
  else upstream.addEventListener('abort', onUpstream, { once: true })

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  const arm = () => {
    clear()
    timer = setTimeout(() => {
      timedOut = true
      controller.abort('idle timeout')
    }, idleMs)
    // A pending read must not hold the process open on its own.
    if (typeof timer?.unref === 'function') timer.unref()
  }

  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    pulse: arm,
    async next(iterator) {
      arm()
      try {
        return await iterator.next()
      } finally {
        clear()
      }
    },
    dispose() {
      clear()
      upstream.removeEventListener('abort', onUpstream)
    },
  }
}

/** Project one catalog entry onto the harness model-info entry. */
function modelInfo(route, model) {
  return {
    provider: route.provider,
    id: model.id,
    name: model.name,
    // The catalog states this per model, not per route: one OpenAI entry is
    // text-only while its siblings take images, and the composer gates
    // attachment on exactly this field.
    inputModalities: [...model.inputModalities ?? ['text']],
  }
}

/**
 * Build the adapter object.
 *
 * @param {object} deps - `config` (resolved), and `resolveApiKey(config)`.
 * @returns {object} the adapter the registry accepts.
 */
function createAdapter({ config, resolveApiKey, resolveAttachments }) {
  const routeOf = provider => config.routes.find(entry => entry.provider === provider)

  /** Open the upstream request and yield translated chunks. */
  async function* request(options, signal, apiKey, attachments, onActivity) {
    // Serialized before the try: refusing unsupported content is a statement
    // about the request, and wrapping it in the transport's catch would report
    // an image as an unreachable endpoint.
    const body = JSON.stringify(attachments === undefined
      ? serializeRequest(options, { maxTokens: config.maxTokens })
      : await serializeRequestWithImages(options, { maxTokens: config.maxTokens }, attachments, signal))
    let response
    try {
      response = await fetch(`${config.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal,
      })
    } catch (error) {
      throw new CliProxyError(
        `CLIProxyAPI at ${config.baseURL} is unreachable`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let detail = text
      try {
        const parsed = JSON.parse(text)
        detail = [parsed?.error?.code, parsed?.error?.type, parsed?.error?.message ?? parsed?.error]
          .filter(part => typeof part === 'string')
          .join(' ') || text
      } catch {
        // A non-JSON error body is still the best description available; the
        // status code carries the classification either way.
      }
      throw new CliProxyError(
        `CLIProxyAPI responded ${String(response.status)}: ${detail.slice(0, 300)}`,
        httpErrorCode(response.status, detail),
        {
          status: response.status,
          ...retryAfterMs(response.headers.get('retry-after')) === undefined
            ? {}
            : { providerRetryAfterMs: retryAfterMs(response.headers.get('retry-after')) },
        },
      )
    }
    if (response.body === null) {
      throw new CliProxyError('CLIProxyAPI returned no response body', 'TRANSPORT')
    }
    yield* translate(parseSse(response.body, onActivity))
  }

  return {
    providerInfo(provider) {
      // Called synchronously inside registerAdapter and gated exactly:
      // `.id === provider` and a non-empty `.name`, or the whole registration
      // is rejected. It must therefore never throw, for any argument.
      const route = routeOf(provider)
      return { id: provider, name: route === undefined ? provider : route.displayName }
    },

    providerRetryPolicy(_provider) {
      // Captured once at registration and later read field by field by the
      // retry plugin, so the object stays flat.
      return config.retryPolicy
    },

    imageRequestPricing(_provider, _model) {
      return undefined
    },

    /** Bind metadata and dispatch without reading credentials or contacting the proxy. */
    async prepareCall(provider, model, signal) {
      const stream = this.stream.bind(this)
      return { model: await this.resolveModel(provider, model, signal), stream }
    },

    async listModels(provider, signal) {
      const route = routeOf(provider)
      if (route === undefined) {
        return Promise.reject(new CliProxyError(`unknown CLIProxyAPI route "${provider}"`, 'INVALID_REQUEST'))
      }
      const models = config.discoverModels
        ? await discoverModels(config, route, await resolveApiKey(config), signal)
        : route.models
      return models.map(model => modelInfo(route, model))
    },

    resolveModel(provider, model) {
      const route = routeOf(provider)
      if (route === undefined) {
        return Promise.reject(new CliProxyError(`unknown CLIProxyAPI route "${provider}"`, 'INVALID_REQUEST'))
      }
      const configured = route.models.find(entry => entry.id === model)
      return Promise.resolve({
        ...configured === undefined
          ? { provider, id: model, name: model, inputModalities: ['text'] }
          : modelInfo(route, configured),
        context: { contextWindow: configured?.contextWindow ?? config.defaultContextWindow },
        defaultMaxTokens: configured?.maxTokens ?? config.maxTokens,
        // `reasoning` is omitted rather than sent empty: an empty efforts
        // array is rejected outright, while omission means the model advertises
        // no effort and an explicit request fails with a clear code.
      })
    },

    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: options => this.stream(options),
      }
    },

    async * stream(options) {
      // Image capability is checked before the credential, the attachment
      // read, and the network: a model that cannot see the image must refuse
      // it here, while the operator can still pick another model.
      const hasImages = options.messages.some(message => contentHasImage(message.content))
      let attachments
      if (hasImages) {
        const route = routeOf(options.provider)
        const model = route?.models.find(entry => entry.id === options.model)
        if (model?.inputModalities?.includes('image') !== true) {
          throw new CliProxyError(
            `Model "${options.model}" does not accept image input.`,
            'UNSUPPORTED_CONTENT',
          )
        }
        // Resolved per request, not at load: Cordis load order must not
        // decide whether images work for the whole process.
        attachments = resolveAttachments?.()
        if (attachments === undefined) {
          throw new CliProxyError(
            'Image input requires the durable attachment service.',
            'UNSUPPORTED_CONTENT',
          )
        }
      }
      // Facts freeze per call: an in-flight stream keeps what it started with,
      // and the next call re-reads configuration and credential.
      const apiKey = await resolveApiKey(config)
      const consumer = new AbortController()
      const upstream = options.signal === undefined
        ? consumer.signal
        : AbortSignal.any([options.signal, consumer.signal])
      const watchdog = idleWatchdog(upstream, config.streamIdleTimeoutMs)
      const iterator = request(
        options,
        watchdog.signal,
        apiKey,
        attachments,
        () => { watchdog.pulse() },
      )[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          if (result.done === true) {
            exhausted = true
            return
          }
          yield result.value
        }
      } catch (error) {
        if (watchdog.timedOut) {
          throw new CliProxyError(
            `CLIProxyAPI stream idle timeout after ${String(config.streamIdleTimeoutMs)}ms`,
            'TIMEOUT',
            { cause: error },
          )
        }
        if (options.signal?.aborted === true) {
          throw new CliProxyError('CLIProxyAPI request aborted by caller', 'ABORTED', { cause: error })
        }
        if (error instanceof CliProxyError) throw error
        throw new CliProxyError(`CLIProxyAPI stream from ${config.baseURL} failed`, 'TRANSPORT', { cause: error })
      } finally {
        // `try/finally`, not `using`: explicit resource management needs Node
        // 24, and the harness supports 22.19 upward.
        watchdog.dispose()
        consumer.abort('CLIProxyAPI stream consumer stopped')
        if (!exhausted && iterator.return !== undefined) {
          try {
            await iterator.return()
          } catch {
            // The consumer controller already owns termination; a return-time
            // abort cannot add a second outcome.
          }
        }
      }
    },
  }
}

module.exports = { createAdapter, idleWatchdog, modelInfo }
