# Install and configure ThunderClaw

ThunderClaw connects directly from Thunderbird to your chosen model provider or
local server. You need Thunderbird 128 or newer and access to a compatible model.
There is no companion service to install.

## Install the extension

Install [ThunderClaw from Thunderbird Add-ons](https://addons.thunderbird.net/en-US/thunderbird/addon/thunderclaw/)
in Thunderbird 128 or newer, then open the extension's settings. Thunderbird
handles normal add-on updates.

For a local development build or an exact GitHub release XPI, open **Add-ons and
Themes**, use the gear menu's **Install Add-on From File**, and select that XPI.
Building a checkout is covered in [development](development.md). Installing a
newer XPI with the same extension ID updates the existing installation;
uninstalling first is unnecessary and may discard settings. Check the version
in ThunderClaw settings after installation. Release qualification uses the exact
release XPI rather than a local rebuild.

## Set up a connection

1. Open ThunderClaw settings from its add-on entry.
2. Choose a provider. Check the API base URL, including any required base path.
3. Enter an API key if the endpoint requires one. Keys are remembered locally.
4. Click **Load models** where available and choose a model, or enter its exact
   **Model ID**. Fireworks AI requires manual entry of its full model, router,
   or deployment ID. Loading a list does not select a model automatically.
5. Review **Structured output**, **Response token limit**, and **Thinking level**.
   Start with the preset defaults. Writing style is optional.
6. Confirm the data-sharing notice, click **Save connection**, and approve
   Thunderbird's request for access to the endpoint's host.
7. Click **Test connection**. It sends synthetic content, never your email, and
   may incur provider charges. Save and retest after changing the connection.

| Provider preset | Default API base | Setup notes |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | Supply your API key and a compatible model. |
| OpenRouter | `https://openrouter.ai/api/v1` | Supply your key; compatibility depends on the selected model and route. |
| DeepSeek | `https://api.deepseek.com` | Supply your key; JSON object compatibility and thinking Off are preset defaults. |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | Supply your key and copy the exact full model, router, or deployment ID from Fireworks; model discovery is unavailable. JSON Schema and Model default thinking are preset defaults. |
| Ollama | `http://127.0.0.1:11434/v1` | Start your local server and make a compatible model available. |
| LM Studio | `http://127.0.0.1:1234/v1` | Start the local API server and load a compatible model. |
| Custom | Enter your API base | Requires compatible models and Chat Completions routes with structured JSON output. |

These are the defaults shipped by ThunderClaw, not a guarantee that every model
on each service supports its request format. See [compatibility](compatibility.md).
Remote endpoints require HTTPS. For local HTTP, use explicit `127.0.0.1` or
`[::1]`; `localhost` is not accepted. Enter the API base, not a full
`/chat/completions` URL. A loopback server can still forward data to the cloud.

## Keys, limits, and thinking

A blank key field preserves an existing key only for the same provider and exact
API base URL. Keys survive restarts and are never synchronized. They are stored
in your Thunderbird profile without an encryption guarantee. Protect profile
backups. **Remove the saved key when saving** removes a key;
**Forget connection and key** removes the saved connection too. Neither revokes
the key at its provider.

The default response limit is **16,384 tokens**. It caps generation to help bound
cost and waiting time; it does not reserve tokens or force a response to use them
all. Reasoning can consume this budget before the final answer. ThunderClaw
accepts 1–131,072, but your model may impose a lower maximum. Increasing it does
not increase the model's input context or remove other safety limits.

Thinking defaults to **Off** for DeepSeek and **Model default** for other presets.
Available levels depend on the provider, and individual models may reject or
reinterpret a level. Fireworks offers Off, Low, Medium, High, Very high, and
Maximum in addition to Model default; start with Model default when support is
unknown. The connection test checks acceptance, not the server's internal
reasoning behavior. For long translations, reducing thinking can leave more room
for the answer. See [response controls](inference-prompts.md#response-limit-and-thinking).

## Use and troubleshoot

In a draft, select eligible text and open ThunderClaw. Generate a proposal,
review Changes, Original, or Proposed in the popup or choose **Expand review**
for a larger window, then Apply the whole suggestion. Undo restores the accepted previous state
when no intervening change makes that unsafe. Sending remains Thunderbird's
normal separate action.

For a received message, choose Summarize or Translate. Translation defaults to
automatic source-language detection; choose the target language. Translations
can be restored to the original, and summaries appear in a separate card.
While a model is running, ThunderClaw shows elapsed time and Cancel. A cancelled
result is not used, though the provider may continue processing or charging.

If model discovery is available but fails, verify the server is running,
endpoint, key, and host permission. You can enter a known model ID manually.
Fireworks requires an exact full ID, such as
`accounts/fireworks/models/deepseek-v4p1-flash-1017`; this is an example, not a
preselected model. If structured output is unsupported, choose **JSON object
compatibility** and save/retest. Both modes
receive the same local validation. A response-limit error means the result was
incomplete: increase the limit within the model's supported range, reduce
thinking, or use a shorter input. Partial output is never applied. For connection
failures, share the version, action, model ID, and sanitized error; never share
keys or real mail in public reports.

See [upgrading](upgrading.md) and the [privacy policy](privacy-policy.md).
