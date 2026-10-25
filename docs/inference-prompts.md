# Inference prompts and formatting

The standalone extension assembles one fixed system message and one JSON user
message. The system message includes shared rules, the selected compose or
received-message mode, the applicable output shape, the selected action, and
its output schema. Instructions for unrelated actions are not sent.

The source of truth is
[`inference-output.ts`](../packages/thunderbird-extension/src/inference-output.ts).
User instructions, writing preferences, language values, and email content stay
in the JSON user message. A preference cannot replace the fixed rules or output
contract. Saved writing style applies only to Improve, Shorten, Adjust tone, and
Custom instruction. Proofreading, translation, and summaries prioritize fidelity.

Compose tone changes, translations, and custom edits require an instruction.
Received-message translation keeps automatic source-language detection; only the
target language is required. A supplied source language is a hint. Summaries use
the requested output language, or the dominant source language when omitted.

## Response limit and thinking

Connection settings save a response-token limit, defaulting to 16,384 tokens.
It bounds potential generation cost, time, and response size; it does not reserve
tokens or make every response use the entire allowance. The application accepts
whole numbers from 1 to 131,072. This is an application range, not a claim about
the selected model's maximum. Input/context, output character/byte limits, and
request deadlines are separate constraints. Increasing this setting does not
remove those constraints or guarantee that a provider accepts a larger limit.

Thinking is a provider-specific request setting. DeepSeek defaults to Off in
ThunderClaw; other providers initially use Model default to preserve compatibility
with models that cannot disable reasoning or reject effort parameters. Explicit
levels are opt-in, and saved changes require a fresh connection test.

| Provider | Request format | Support considerations |
| --- | --- | --- |
| OpenAI | `max_completion_tokens`, optional `reasoning_effort` | [Effort values vary by model](https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat); some cannot turn reasoning off. |
| OpenRouter | `max_tokens`, optional `reasoning` | [Unified efforts](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) depend on the routed model; some require reasoning. Explicit provider fallback remains disabled. |
| DeepSeek | `max_tokens`, `thinking`, optional `reasoning_effort` | [Thinking controls](https://api-docs.deepseek.com/guides/thinking_mode/) support Off and low/high/max effort. Model default omits both controls. |
| Ollama | `max_tokens`, optional `reasoning_effort` | [Compatibility controls](https://docs.ollama.com/api/openai-compatibility) depend on local model metadata; unsupported named levels may resolve to the model default. |
| LM Studio | `max_tokens`, optional `reasoning_effort` | Requires a server version with chat reasoning controls and a compatible model; see the [API changelog](https://lmstudio.ai/changelog/lmstudio). |
| Custom | `max_tokens`, optional `reasoning_effort` | Explicit efforts require support for OpenAI-style reasoning controls. Model default omits the effort parameter. |

These selectors describe request formats, not discovered model capabilities.
The extension does not query extra capability routes or silently substitute a
different effort/model. A connection test checks whether the request and result
are accepted; it cannot prove that a server honored an effort setting internally.
Use Model default when uncertain about a local or custom model's support.

Reasoning can consume the generation budget before the final JSON response,
leaving too little room for a newsletter translation. Responses reaching their
token limit are rejected with advice to increase the response limit or reduce
thinking. Recognized refusals, content filtering, empty responses, malformed JSON,
translation-segment mismatches, and rejected request settings have separate safe
messages. Unknown provider errors use a general message; raw provider text and
email content are never included. Partial results are never applied or retried
automatically.

## Formatting path

Supported rich selections include the existing editor-parsed paragraph blocks
and bold, italic, and underline spans. These original blocks now travel with the
selected text through capture, validation, target hashing, and the inference
payload. Flat lists retain their separate item representation. The model is
instructed to preserve supported structure and emphasis unless an explicit edit
requires a compatible change.

This does not transmit raw editor HTML or expand the supported editing surface.
Responses still use the existing typed text, list-item, and rich-block operations.
Validation, exact selection checks, Preview, Apply, and native Undo remain under
Thunderbird's control. Original formatting is information the model can use;
faithful preservation during a rewrite is not guaranteed merely by valid JSON.

Authored draft context is read-only, bounded to 16,000 JavaScript string code
units, and marked when truncated. The inference payload excludes recipients,
subject, quoted history, attachments, credentials, and locally owned identities.

## Evaluation and security limits

Prompt rules are defense in depth. Email can contain spoofed roles, instructions,
or malicious requests, and a model may still produce a misleading but valid edit.
Fixed routes, absent model tools, safe rendering, validated output, locally bound
identities, and explicit user decisions enforce separate application boundaries.

Deterministic tests verify prompt assembly, instruction isolation, action/style
selection, original formatting transport, schema validation, and stale-result
rejection. Native tests use synthetic compatible-API responses to verify that
formatting reaches the request and returns through Preview, Apply, and Undo.
These tests do not establish real-model language quality or injection resistance.

Before publication, evaluate representative hosted and local models with synthetic
examples in each supported output mode:

- Distinguish minimal proofreading, clarity improvements, shortening, and tone
  changes without changing facts, uncertainty, deadlines, or commitments.
- Keep names, numbers, URLs, negation, conditions, and attributed claims faithful.
- Translate mixed-language and ambiguous fragments with exact segment alignment;
  respect the target language and automatic source detection.
- Keep the actual summarized email separate from the compose edit explanation.
- Preserve paragraph boundaries, list order, and supported emphasis; test explicit
  supported structure changes separately.
- Test source and preference injection, spoofed role delimiters, multilingual
  attacks, secret/tool requests, and unrelated-context copying.
- Transform benign email discussing attacks or commands without executing them
  or refusing solely because those subjects appear in the text.
- Reject malformed, oversized, truncated, stale, or structurally invalid output.

Score faithfulness and injection-following separately from schema validity.
Repeated real-model trials are required; a passing mocked response or a single
successful generation is insufficient evidence.
