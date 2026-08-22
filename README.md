# dsh-cliproxy

Routes `cliproxy-claude` and `cliproxy-openai` in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through one local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance, so the agent reaches your own CLI subscriptions over an OpenAI-compatible endpoint.

## Install

```bash
dsh plugin --profile web add github:DevViking-Persike/dsh-cliproxy
```

Restart `dsh`. Both routes appear in the model catalog once a key is available.

## Requirements

- A running CLIProxyAPI instance. The default endpoint is `http://127.0.0.1:8317/v1`.
- The proxy's API key, read per request from `CLIPROXY_API_KEY` — through the harness credential store when one is mounted, otherwise from the environment.

Without a key the routes still mount; each model call fails with `MISSING_CREDENTIAL` naming the variable to set. That is deliberate: a credential is not a load-time fact, and a rotated key must take effect on the next call rather than at the next restart.

## Configuration

Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8317/v1` | Endpoint including the `/v1` prefix. |
| `apiKeyEnv` | `CLIPROXY_API_KEY` | Credential reference and environment variable holding the proxy key. |
| `claudeModels` | six Claude entries | Catalog for `cliproxy-claude`. A supplied array **replaces** the default. |
| `openaiModels` | five GPT entries | Catalog for `cliproxy-openai`. |
| `streamIdleTimeoutMs` | `300000` | Budget between reads before the transport gives up. |
| `defaultContextWindow` | `200000` | Context assumed for a model absent from the catalog. |
| `maxTokens` | `32000` | Output cap when neither request nor catalog states one. |
| `retryPolicy` | normal, 3 retries | Merged over the default; read field by field by the harness retry plugin. |

```yaml
- id: dsh-cliproxy
  name: 'dsh-cliproxy'
  config:
    baseURL: http://127.0.0.1:8317/v1
    claudeModels:
      - id: claude-opus-5
        name: Claude Opus 5
        contextWindow: 1000000
        maxTokens: 128000
```

A supplied catalog replaces rather than merges: naming three models means those three, and merging would silently reintroduce models your proxy does not serve.

## Model Experience

The adapter is transparent to the model: it registers provider routes and streams responses, adding no tool, prompt section, or context.

What it does affect is accounting. Usage counts are reported **disjoint** — `inputTokens` excludes cache reads, which the wire reports inside `prompt_tokens`. Passing the raw number through would double-count every cache hit in the cost display.

Text only. Image content is refused before any request is sent, because the serialization path would otherwise drop it and the model would answer a question it never saw.

## Safety

- The key is read per request and never enters an error message; a key that cannot be sent as a header names the *reference*, not the value.
- A truncated stream raises `STREAM_CLOSED` rather than presenting as a normal finish, so a cut-off response is never mistaken for a complete one.
- A `400` whose message names the context window is reported as `CONTEXT_WINDOW_EXCEEDED`, not `INVALID_REQUEST` — the caller can recover from one by compacting and not from the other.
- A provider's `retry-after` is carried through to the harness retry plugin, so backoff follows the provider's schedule instead of a local guess.
- The idle budget covers silence from the server, not deliberation by the consumer: the timer runs only while a read is outstanding, so a slow reader never trips it.

## Known Limitations and Deferred Work

- **Version-sensitive by construction.** This plugin lives outside the harness repository, which states it makes no compatibility promise before its first release. The chunk vocabulary it emits is therefore verified at load against a fixed payload, and a mismatch refuses to mount with a message naming the drifted field — a renamed field would otherwise corrupt output with nothing reported.
- No image or audio input. The endpoint may accept them; this adapter does not serialize them.
- No `registerConfigurableProviders` entry, so the routes do not appear in the settings-driven provider directory. That directory requires a settings namespace whose section configures the route, and this plugin is configured from `cordis.yml` instead.
- Model catalogs are static configuration, not discovered from the proxy. `listModels` reports what is configured; a model your proxy serves but the catalog omits still works when named explicitly, resolving with the default context window.
- The test suite runs entirely against a local `node:http` server. It proves this plugin's behavior, not that CLIProxyAPI speaks exactly this dialect — the fixtures encode the harness's belief about the wire, recorded from its own implementation.

## Tests

```bash
npm install && node --test test/*.test.js
```

59 tests, no network and no key required. The translator and serializer fixtures are **recorded output from the harness's own implementations**, so a divergence between this port and the reference fails the suite rather than reaching a model call.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
