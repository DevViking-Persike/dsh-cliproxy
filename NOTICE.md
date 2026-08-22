# Third-party notices

## DeepSeek Harness

This plugin targets [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).
The chunk vocabulary, failure codes, and message-serialization rules it
implements were read from that project's `packages/llm` sources, and its own
`llm-cliproxy` package is the reference this port was verified against: the
translator and serializer test fixtures are recorded output from the in-tree
implementations, so a divergence fails the suite.

This plugin imports no harness package; every capability is reached through
`ctx` at run time.

## CLIProxyAPI

Targets the OpenAI-compatible endpoint exposed by
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). No code from that
project is included.

## eventsource-parser

Server-sent-event framing is [`eventsource-parser`](https://github.com/rexxars/eventsource-parser)
(MIT), installed as an ordinary npm dependency.
