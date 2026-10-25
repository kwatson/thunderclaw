# Install and configure ThunderClaw

This describes the standalone development extension. Published older extensions use OpenClaw pairing; consult documentation at their exact release tags. Do not assume a development build has completed marketplace review or live-provider qualification.

Install the ThunderClaw XPI in Thunderbird, open its settings, and choose OpenAI, OpenRouter, DeepSeek, Ollama, LM Studio, or a custom compatible endpoint. Select or enter a model and provide the endpoint's API key if needed. Approve access to that host, save the connection, and test it with synthetic content before using email actions.

Keys are saved on this device and survive restarts. They are not synchronized or an encrypted vault. Replace/remove a key in settings. Use HTTPS for remote servers; local server presets use explicit loopback HTTP. Start/load a suitable model in Ollama or LM Studio yourself. A local endpoint is not a guarantee of local inference if the server uses cloud models.

## Existing OpenClaw users

The new extension does not convert a paired device credential into an API key, read OpenClaw files, or contact the old Gateway automatically. Configure your chosen provider explicitly. Previous agent personality, memory, and fallback configuration do not transfer; enter desired writing preferences in ThunderClaw settings.

Removing local pairing data does not revoke the remote device. Disconnect using the older extension before upgrading, or revoke its device through OpenClaw administration afterward. Historical plugin releases and their credentials are separate from the new extension configuration.

Generate previews before Apply, and use Undo when needed. The model never sends mail or changes recipients, headers, or attachments.
