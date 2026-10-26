# ThunderClaw compatibility

## Thunderbird and platforms

| Surface | Baseline | Qualification boundary |
| --- | --- | --- |
| Thunderbird | 128 and newer | Plain selected-text actions, summaries, and received-message translation |
| Rich compose | Qualified Thunderbird 153 and newer shapes | Supported paragraphs, flat lists, bold, italic, and underline; runtime checks reject unsupported selections |
| Hosted release automation | Pinned Thunderbird 153.0.3 on Linux and Windows | Exact candidate XPI and deterministic compatible-API fixture |
| Local Linux compatibility harness | Pinned 128.14.0esr and 153.0.3 | Two fresh profiles per version, including restart/persistence checks |
| Development | Node.js 24 through `mise` | Use the exact repository runtime pin |

ThunderClaw targets desktop Linux, Windows, and macOS. Hosted automated compose
qualification currently covers Linux and Windows. Prior manual macOS smoke use
does not establish qualification of every new candidate; repeat platform smoke
checks for the intended release. Hosted macOS compose automation remains deferred.
A minimum manifest version is not a claim that every newer editor shape works.
See the [product contract](product-contract.md) for eligibility rules.

## Inference API

ThunderClaw supports OpenAI-compatible, nonstreaming Chat Completions. Presets
provide API bases and request defaults for OpenAI, OpenRouter, DeepSeek,
Fireworks AI, Ollama, and LM Studio; Custom accepts another compatible base.
The extension appends `/models` for discovery where supported and
`/chat/completions` for generation. Fireworks model discovery is unavailable;
enter an exact full model, router, or deployment ID manually. ThunderClaw never
silently chooses a model, changes endpoints, or retries with a fallback model.

The endpoint/model must accept the configured structured-output mode and return
a complete, bounded JSON result. JSON Schema is the default for most presets;
DeepSeek defaults to JSON object compatibility; Fireworks defaults to JSON Schema.
Local validation is equally strict in both modes. Chat-only models without suitable
structured output may fail despite accepting ordinary chat requests.
Fireworks requests reject cases where the prompt plus requested output budget
exceeds the context window, instead of silently reducing the output allowance.
An over-limit request fails without applying partial output.

Response limits and reasoning controls differ by provider and model. Presets
select a request vocabulary, not a discovered capability guarantee. See
[installation](installation.md) for defaults and
[response controls](inference-prompts.md#response-limit-and-thinking) for the
implemented parameter mappings. Saving changes requires another synthetic
connection test before email actions.

## Evidence and limits

Deterministic fixtures cover provider request mappings, validation, permission
and credential scope, cancellation, and local editor behavior. Live DeepSeek
Flash trials have exercised synthetic actions and a received-newsletter
translation. That does not establish every model's accuracy or full provider
coverage. Repeat representative hosted/local model trials for the exact candidate;
record source and artifact digests and keep mocked versus live evidence distinct.

A connection test checks a bounded synthetic generation, not all actions,
formatting fidelity, privacy, or resistance to malicious email instructions.
The server can accept a reasoning parameter without honoring it. Loopback
servers can use cloud models, and routing services can use upstream providers.

Native test profiles currently disable remote extension-document isolation so
Marionette can address settings and popup contexts. This limits what those
trials prove about default process isolation. Broader upgrade, permission,
certificate, and platform coverage remains on the [roadmap](roadmap.md).
