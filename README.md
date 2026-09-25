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

Restart DSH. The enabled routes query `/v1/models` when the Harness requests their catalogs, so only models currently exposed by your proxy appear. Installing the plugin does not perform OAuth login.

When Claude and Codex already come from `dsh-subscriptions`, enable only `routes: [gemini]` here to avoid presenting alternative proxy routes for the same model families.

## Gemini / AGY (Antigravity) Login

CLIProxyAPI owns [Antigravity OAuth login](https://help.router-for.me/configuration/provider/antigravity). Run this once:

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
| `routes` | `[claude, openai, gemini]` | Provider families to register. Use `[gemini]` alongside `dsh-subscriptions`. |
| `discoverModels` | `true` | Query the authenticated `/v1/models` endpoint for available model ids. Set `false` for an explicitly managed offline catalog. |
| `modelDiscoveryTimeoutMs` | `10000` | Deadline for each catalog request. |
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
    routes: [gemini]
    geminiModels:
      - id: gemini-pro-agent
        name: Gemini 3.1 Pro High
        contextWindow: 1048576
        maxTokens: 65535
        inputModalities: [text, image]
```

## Discovery and Routing

The proxy's [OpenAI model endpoint](https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/api/handlers/openai/openai_handlers.go) exposes available ids, not context windows or image capabilities. This plugin attaches configured metadata for known ids. New ids with the route's `claude-`, `gpt-`, or `gemini-` prefix appear as text-only with the configured default context and output limits. Custom aliases must be listed in the corresponding model catalog. An explicit catalog restricts discovery to its listed ids; it does not advertise configured models absent from the proxy response. Catalog errors remain visible and do not silently fall back to potentially unavailable models.

The Gemini route identifies a model family, not an authenticated Google account. CLIProxyAPI chooses the backend and account; configure it to serve Gemini through Antigravity if that is the intended credential source. Account eligibility and quotas remain controlled by Google. No Google OAuth client secret, access token, or refresh token is bundled with this plugin. Existing Claude/Codex authentication remains in `dsh-subscriptions` when that plugin is used.

## Pin Gemini to Antigravity

`routes: [gemini]` selects the Harness model family; it does not select a backend account. If the proxy also serves Gemini through other providers, create a unique alias under its Antigravity OAuth channel, as supported by the [CLIProxyAPI configuration](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml):

```yaml
# CLIProxyAPI configuration, not cordis.yml:
oauth-model-alias:
  antigravity:
    - name: gemini-pro-agent
      alias: agy-gemini-pro
      fork: true
```

Then select only that alias in the Harness plugin configuration:

```yaml
routes: [gemini]
geminiModels:
  - id: agy-gemini-pro
    name: Gemini Pro (AGY / Antigravity)
    contextWindow: 1048576
    maxTokens: 65535
    inputModalities: [text, image]
```

Keep the alias exclusive to Antigravity across all proxy providers. Model ids and limits must match the upstream model actually exposed by your installation. Discovery will list the alias only after CLIProxyAPI exposes it. This configuration is an operator example; installing this plugin does not rewrite your proxy configuration or initiate login.

## Model Experience

The adapter is transparent to the model: it registers provider routes and streams responses, adding no tool, prompt section, or context. Usage counts are disjoint — `inputTokens` excludes cache reads already counted inside `prompt_tokens`.

Text and image input are supported for catalog entries declaring image capability. Images resolve through the Harness attachment service and are serialized as data URLs. Unknown models default to text-only; audio and video are refused.

The adapter implements `prepareCall()` without reading credentials or querying the catalog. Dispatch retains the prepared adapter and reads the proxy access key only when the stream starts. Image request pricing is unspecified, so the Harness uses its neutral estimate.

## Safety

- Google access/refresh tokens remain entirely inside CLIProxyAPI's `auth-dir`.
- The proxy access key is read per request and never enters an error or log. Local-config discovery is disabled automatically for non-loopback destinations.
- A truncated stream raises `STREAM_CLOSED` instead of looking complete.
- `retry-after` reaches the harness retry plugin; idle timeout measures server silence, never a slow consumer.
- Chunk fields are checked at load against this adapter's expected payload vocabulary. This self-check does not negotiate the installed Harness version; compatibility must also be verified against the target Harness.

## Known Limitations

- Discovery reflects the proxy catalog at the time it is requested; availability can change before dispatch. An uncatalogued model still resolves when named explicitly, with default limits and text-only input.
- No audio/video serialization. Image support requires both configured model capability and the Harness attachment service.
- The plugin has no settings-directory entry; it is configured by `cordis.yml`.
- Tests use local HTTP servers and recorded harness translator/serializer output. Real OAuth and model availability remain vendor-controlled.

## Tests

```bash
npm install && node --test test/*.test.js
```

The suite uses temporary loopback HTTP servers; no provider credentials or vendor network access are required. Discovery tests cover account-visible ids, configured aliases, route selection, authentication errors, cancellation, and prepared dispatch.

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
