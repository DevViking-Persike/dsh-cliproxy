# dsh-cliproxy

Routes Claude, OpenAI/Codex, and **Gemini through Antigravity OAuth** in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) through one local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance.

The Gemini route uses your Google/Antigravity account — **not a Gemini API key**. CLIProxyAPI owns the browser login, refresh token, Google project, native request fingerprint, and translation; this plugin is its OpenAI-compatible DSH client.

| DSH provider | Authentication owned by CLIProxyAPI |
|---|---|
| `cliproxy-claude` | Claude Code subscription |
| `cliproxy-openai` | Codex/OpenAI subscription |
| `cliproxy-gemini` | Google Antigravity OAuth |

## Install

```bash
dsh plugin --profile web add github:DevViking-Persike/dsh-cliproxy
```

Restart DSH. All three routes then appear in the model catalog.

## Gemini / Antigravity Login

CLIProxyAPI 7.x already implements the public Antigravity OAuth client. Run this once:

```bash
cliproxyapi -config "$(brew --prefix)/etc/cliproxyapi.conf" -antigravity-login
```

Authorize the Google account in the browser. CLIProxyAPI writes `antigravity-<email>.json` under its configured `auth-dir` (normally `~/.cli-proxy-api`) and refreshes it itself. This DSH plugin never reads the Google access or refresh tokens.

The key named below is only the local proxy's access control between DSH and `127.0.0.1:8317`; it is **not** a Gemini API key. For a loopback endpoint, the plugin reads the first `api-keys` entry from the local CLIProxyAPI config by default, so no environment variable is required and the key is never displayed.

## Requirements

- A running CLIProxyAPI instance; default endpoint `http://127.0.0.1:8317/v1`.
- For Gemini, a completed `-antigravity-login`.
- Either a proxy access key in the harness credential store / `CLIPROXY_API_KEY`, or a readable local proxy config. Local config discovery is allowed only for loopback URLs; a local key is never sent to a remote endpoint implicitly.

## Configuration

Every field is optional.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8317/v1` | Endpoint including `/v1`. |
| `apiKeyEnv` | `CLIPROXY_API_KEY` | Optional credential reference/environment variable for the proxy access key. |
| `proxyConfigPath` | First existing standard Homebrew path | Local CLIProxyAPI YAML from which the first proxy access key may be read. The plugin checks `/opt/homebrew/etc/cliproxyapi.conf`, then `/usr/local/etc/cliproxyapi.conf`. |
| `readLocalProxyKey` | `true` | Allow local config discovery for loopback endpoints only. |
| `claudeModels` | six Claude entries | Catalog for `cliproxy-claude`; a supplied array replaces the default. |
| `openaiModels` | five GPT entries | Catalog for `cliproxy-openai`. |
| `geminiModels` | eight Gemini entries | Antigravity catalog for `cliproxy-gemini`. |
| `streamIdleTimeoutMs` | `300000` | Budget between stream reads. |
| `defaultContextWindow` | `200000` | Context assumed for an uncatalogued model. |
| `maxTokens` | `32000` | Default output cap. |
| `retryPolicy` | normal, 3 retries | Merged over the harness-compatible default. |

```yaml
- id: dsh-cliproxy
  name: dsh-cliproxy
  config:
    baseURL: http://127.0.0.1:8317/v1
    geminiModels:
      - id: gemini-pro-agent
        name: Gemini 3.1 Pro High
        contextWindow: 1048576
        maxTokens: 65535
```

## Why the Proxy Owns Antigravity

A direct client is significantly more than an OAuth bearer token. The upstream wire requires:

- Google OAuth scopes and the registered Antigravity public client;
- project discovery/onboarding through `loadCodeAssist`;
- `daily-cloudcode-pa.googleapis.com` / `cloudcode-pa.googleapis.com` routing;
- an `antigravity/hub/<version>` user agent and HTTP/1.1 fingerprint;
- a Gemini body nested inside an Antigravity envelope with project, request, and session ids;
- tool-schema sanitization, encrypted reasoning replay, model-specific output caps, and token refresh.

CLIProxyAPI already owns and tests those facts. Duplicating them here would produce two token writers and a second independently drifting protocol implementation. This plugin therefore sends OpenAI-compatible streaming requests to the loopback proxy and never copies Google's client secret or account tokens.

## Model Experience

The adapter is transparent to the model: it registers provider routes and streams responses, adding no tool, prompt section, or context. Usage counts are disjoint — `inputTokens` excludes cache reads already counted inside `prompt_tokens`.

Text only. Image, audio, and video are refused before a request is sent, although some Antigravity models support them upstream; this adapter's serializer does not yet preserve those inputs.

## Safety

- Google access/refresh tokens remain entirely inside CLIProxyAPI's `auth-dir`.
- The proxy access key is read per request and never enters an error or log. Local-config discovery is disabled automatically for non-loopback destinations.
- A truncated stream raises `STREAM_CLOSED` instead of looking complete.
- `retry-after` reaches the harness retry plugin; idle timeout measures server silence, never a slow consumer.
- Chunk fields are checked at load against a fixed payload, so harness protocol drift refuses to mount instead of corrupting tool calls silently.

## Known Limitations

- Model catalogs are static defaults copied from CLIProxyAPI's Antigravity registry; an uncatalogued model still resolves when named explicitly. Supplying `geminiModels` replaces the defaults.
- No image/audio/video serialization yet.
- The plugin has no settings-directory entry; it is configured by `cordis.yml`.
- Tests use local HTTP servers and recorded harness translator/serializer output. Real OAuth and model availability remain vendor-controlled.

## Tests

```bash
npm install && node --test test/*.test.js
```

64 tests, no network and no credential required.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
