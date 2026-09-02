# ThunderClaw OpenClaw plugin

This package is the OpenClaw half of ThunderClaw. It exposes the fixed,
paired-device HTTP routes used by the separately installed ThunderClaw
extension for Mozilla Thunderbird.

Install the exact release archive through OpenClaw or ClawHub, enable the
`thunderclaw` plugin, then use the operator command to review pairing requests:

```text
openclaw plugins install --accept-capabilities clawhub:@thunderclaw/openclaw-plugin
openclaw plugins enable thunderclaw
openclaw gateway restart
openclaw thunderclaw
```

Capability consent during installation and approval of a Thunderbird pairing
request are separate operator decisions.

ThunderClaw lists existing configured OpenClaw agents and does not create one
during installation or pairing. The default `main` agent is supported. A
dedicated agent is optional when separate mail personality, workspace, memory,
or model configuration is desirable; create one with `openclaw agents add
ThunderClaw`, then verify it from ThunderClaw's Thunderbird settings.

Provider credentials, configured agents, models, and model fallbacks remain in
OpenClaw. The Thunderbird extension receives only a narrow paired-device
credential. See the ThunderClaw repository's installation, security, and
compatibility documentation before enabling the plugin.

The package includes `assets/thunderclaw-plugin-icon.png` as a copy of its
256-pixel catalog artwork. OpenClaw loads the identical public brand derivative
through the HTTPS URL declared in `openclaw.plugin.json`.

Licensed under Apache-2.0. The ThunderClaw name and marks are governed by the
repository's trademark policy.
