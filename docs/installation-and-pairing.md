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

Do not repair a missing or disabled plugin by editing its SQLite registry or
OpenClaw core database. Use the supported plugin install/update lifecycle.

The normative protocol is in
[`reference/pairing-protocol-v1.md`](reference/pairing-protocol-v1.md).
