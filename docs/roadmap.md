# ThunderClaw roadmap

Last reconciled: 2026-10-24

This file contains unfinished work only. Current behavior belongs in the
product and architecture documents; completed test results belong in release
provenance and CI artifacts.

## Now: standalone extension

1. Extend verified Linux128/153 restart/key persistence and compose trials to old-release upgrades, credential isolation in email contexts, permission removal, and native platform coverage.
2. Run the exact standalone candidate through real Thunderbird compose/message/Undo qualification and representative synthetic OpenAI, OpenRouter, DeepSeek, Ollama and LM Studio trials. Keep modeled compatibility distinct from live evidence.
3. Complete extension release and reviewer-source qualification without plugin counterpart or ClawHub dependencies.
4. Review remaining legacy OpenClaw development dependencies, runtime source, and unused publishing credentials for separate retirement. Publishing workflows and admission automation are retired; preserve immutable release history and existing local Gateway state.

See [standalone migration](standalone-migration.md) for scope and acceptance gates. Historical OpenClaw work is retained in Git history and its release documents.
