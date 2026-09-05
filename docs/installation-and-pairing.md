# Installing and pairing ThunderClaw

## Distribution

ThunderClaw is distributed as two independent artifacts:

- a signed Thunderbird MailExtension with stable extension ID
  `thunderclaw@addons.thunderbird.net`; and
- the `@thunderclaw/openclaw-plugin` package installed into a supported
  OpenClaw runtime through [ClawHub](https://docs.openclaw.ai/clawhub/publishing).

There is no helper application, Native Messaging host, Microsoft Store/MSIX
package, or privileged operating-system registration.

For development installation from source, see
[`development.md`](development.md). The two components version independently.
Install a pair listed as compatible in the component release notes and
[`compatibility.md`](compatibility.md); numeric versions do not need to match.

Stable OpenClaw `2026.9.2` requires the operator to accept a plugin's declared
capabilities before activation. Install ThunderClaw from ClawHub with explicit
consent, then enable it and restart the Gateway:

```text
openclaw plugins install --accept-capabilities clawhub:@thunderclaw/openclaw-plugin
openclaw plugins enable thunderclaw
openclaw gateway restart
```

This capability consent authorizes installation in OpenClaw. It does not
approve a Thunderbird device; each device still follows the separate pairing
flow below. If ThunderClaw was installed without recording consent, recover
with `openclaw plugins enable --accept-capabilities thunderclaw` and restart the
Gateway.

## Choose an OpenClaw agent

ThunderClaw does not create or modify OpenClaw agents during installation or
pairing. It lists the agents already configured on the Gateway. Using the
existing `main` agent is fully supported and is the simplest choice for most
personal installations.

Every ThunderClaw operation still uses a caller-owned in-memory session with
model-callable tools and trajectory disabled. Selecting `main` does, however,
allow the personality and workspace or memory context that OpenClaw supplies
for `main` to influence the model request. This can be useful when the user
wants their established assistant voice and context in email.

An operator may instead create an optional dedicated agent:

```text
openclaw agents add ThunderClaw
openclaw agents list
```

The interactive OpenClaw wizard creates a separate workspace, agent state,
personality, memory, and session store and allows an independent model choice.
No channel binding is required for ThunderClaw. After adding the agent, refresh
the connection in Thunderbird and complete its restricted compatibility check
before selecting it for mail operations.

A dedicated agent is context separation, not a strong security boundary.
Agents in the same Gateway profile still share the Gateway process and its
installed global plugins and hooks. Deployments that require isolation from
those components need a separately controlled Gateway profile. See
[`security-and-privacy.md`](security-and-privacy.md) for the complete trust
boundary.

## Connection requirements

Configure Thunderbird with the ThunderClaw plugin API base. Remote endpoints
must use HTTPS. Cleartext HTTP is accepted only for canonical `127.0.0.1` and
`[::1]` loopback endpoints. Thunderbird requests the required host permission
for the configured origin before connecting.

The Thunderbird extension never receives an OpenClaw provider credential or a
broad Gateway/operator credential.

## Pairing flow

1. In Thunderbird, choose **Pair this Thunderbird**.
2. Thunderbird creates a stable installation identity, a prospective device
   credential, and a separate one-time claim secret. It sends only identifiers
   and domain-separated verifiers to the plugin.
3. Thunderbird displays a short approval code.
4. An authenticated OpenClaw operator runs:

   ```text
   openclaw thunderclaw
   ```

5. The operator selects the pending request whose device identity and code
   match Thunderbird and approves it.
6. The user returns to Thunderbird and chooses **Claim approved pairing**
   before the request expires.

Approval and Claim are separate decisions. The operator CLI never claims a
request because only Thunderbird holds the one-time claim secret.

ThunderClaw pairing is distinct from OpenClaw core browser/device pairing.
ThunderClaw requests do not appear in `openclaw devices list`, and core
`devices approve`, `reject`, or `revoke` commands do not administer ThunderClaw
credentials.

## Operator command

The guided command lists pending requests and connected credentials, uses
numbered selections, and reads approval codes without echoing them. It displays
a bounded recent history by default and offers an explicit full-history view.

Stable noninteractive commands are available for automation:

```text
openclaw thunderclaw status --json
openclaw thunderclaw requests list --json
openclaw thunderclaw devices list --json
openclaw thunderclaw requests deny REQUEST_ID --yes --json
openclaw thunderclaw devices revoke CREDENTIAL_ID --yes --json
```

Headless approval accepts exactly one newline-terminated code through stdin.
There is deliberately no approval-code command-line argument:

```bash
IFS= read -r -s -p "Approval code: " thunderclaw_approval_code
printf '\n' >&2
printf '%s\n' "$thunderclaw_approval_code" | \
  openclaw thunderclaw requests approve REQUEST_ID \
    --code-stdin --yes --json
unset thunderclaw_approval_code
```

Do not use command substitution, JSON parameters, or another form that places
the code in process arguments or shell history. JSON is written to stdout;
prompts and human-readable errors are written to stderr.

The CLI uses normal OpenClaw operator authentication. Status and list commands
request `operator.read`; approve, deny, and revoke request `operator.admin`.
The command accepts no ThunderClaw-specific Gateway URL, token, or password.

Authentication or insufficient scope exits `5`. Gateway transport, timeout,
unavailable registry, or missing-method failure exits `6`. A transport failure
after a mutation may have an unknown outcome. Do not automatically repeat an
ambiguous approve, deny, or revoke; inspect the current request/device list and
use any returned reconciliation result first.

## Lifecycle operations

### Rotation

Thunderbird generates the replacement credential. The plugin transactionally
creates it and revokes the old credential. Thunderbird must persist the new
credential before discarding the old one. Ambiguous results use the durable
rotation journal and fail closed rather than guessing which credential won.

### Disconnect

Disconnect attempts authenticated remote revocation before deleting local
credential custody and host permission. A confirmed revocation returns the
extension to an unconfigured state. An ambiguous network result must be
reported honestly and reconciled before destructive retry.

### Forget

Forget removes local credential custody and permission even when remote
revocation cannot be confirmed. The UI must state that the remote credential
may still require operator revocation.

### Operator revocation and expiry

The operator can revoke one exact credential. Device names are labels, not
identities. Expired or operator-revoked credentials retire the active
Thunderbird connection and require recovery or pairing again.

`requests deny` applies only to a pending request. Protocol v1 does not cancel
an approved, unclaimed request; it remains claimable until its fixed expiry.

## Diagnosis

If `thunderclaw` is absent from root CLI help, inspect the installed plugin:

```text
openclaw plugins inspect thunderclaw --runtime --json
```

A usable inspection reports the plugin enabled, loaded, and activated and
includes `thunderclaw` in `cliCommands`. Discovery-mode inspection intentionally
does not initialize the pairing registry or report the full Gateway's methods
and routes. Verify the running Gateway separately:

```text
openclaw thunderclaw status --json
```

The OpenClaw plugin screen obtains the packaged ThunderClaw icon through the
Gateway from `assets/icon.png` in the installed plugin directory. If it shows
an initials tile immediately after an update, restart the Gateway and reload
the OpenClaw UI so both use the new plugin metadata. If the fallback remains,
confirm that `openclaw gateway call plugins.list --json` reports `hasIcon:
true` for `thunderclaw`; the cold `openclaw plugins list --json` inventory does
not expose this presentation field. If the Gateway field is absent even though
the installed `assets/icon.png` is present, run `openclaw plugins registry
--refresh` and restart the Gateway to rebuild stale discovery metadata. A
genuinely missing icon should be repaired through the supported plugin update
lifecycle. An unavailable icon does not change plugin execution or pairing
state.

Do not repair a missing or disabled plugin by editing its SQLite registry or
OpenClaw core database. Use the supported plugin install/update lifecycle.

The normative protocol is in
[`reference/pairing-protocol-v1.md`](reference/pairing-protocol-v1.md).
