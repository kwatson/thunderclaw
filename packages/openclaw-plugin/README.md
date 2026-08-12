# ThunderClaw OpenClaw plugin

This package is the OpenClaw half of ThunderClaw. It exposes the fixed,
paired-device HTTP routes used by the separately installed ThunderClaw
extension for Mozilla Thunderbird.

Install the exact release archive through OpenClaw or ClawHub, enable the
`thunderclaw` plugin, then use the operator command to review pairing requests:

```text
openclaw thunderclaw
```

Provider credentials, configured agents, models, and model fallbacks remain in
OpenClaw. The Thunderbird extension receives only a narrow paired-device
credential. See the ThunderClaw repository's installation, security, and
compatibility documentation before enabling the plugin.

Licensed under Apache-2.0. The ThunderClaw name and marks are governed by the
repository's trademark policy.
