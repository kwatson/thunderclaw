# ThunderClaw pairing protocol v1

## Security boundary

ThunderClaw pairing connects one Thunderbird installation to the separately
installed ThunderClaw OpenClaw plugin. The extension receives no provider
credential and no broad OpenClaw Gateway credential. OpenClaw operator
approval stays on authenticated Gateway administration methods; the extension
uses only the public pairing routes and narrow product routes.

The raw per-device credential is generated and retained by the Thunderbird
background context inside the Thunderbird profile. The plugin stores only a
domain-separated verifier. A local profile compromise can therefore expose the
credential; reversible encryption with a key in the same profile would not
change that boundary. Per-device identity, narrow capabilities, expiry,
rotation, independent revocation, and Forget/Disconnect behavior limit the
impact.

Email bodies, recipients, headers, attachments, provider credentials, Gateway
credentials, raw device credentials, and claim secrets never belong in the
pairing registry.

## Protocol

All HTTP responses are JSON with `Cache-Control: no-store`. Identifiers are
20–64 character base64url strings. Raw device and claim secrets contain at
least 256 random bits. Verifiers are SHA-256 hashes with distinct domain
prefixes; this is safe only because the inputs are uniformly random,
high-entropy values rather than human passwords.

1. Thunderbird generates a request ID, stable installation-scoped device ID,
   prospective credential ID and raw device credential, plus a separate
   one-time claim secret. It sends only their IDs and verifiers to
   `POST /thunderclaw/pairing/v1/requests`.
2. The plugin creates a short-lived request, rate-limits the source, and returns
   a ten-character human approval code. The code is stored only as a verifier.
3. An authenticated OpenClaw operator runs the plugin-owned `openclaw
   thunderclaw` manager, checks the displayed device identity and approval
   code, and approves the selected request. The manager calls
   `thunderclaw.pairing.requests` and `thunderclaw.pairing.approve` through the
   existing scoped Gateway boundary. Operator methods require `operator.read`
   or `operator.admin`; they are not HTTP product credentials. Direct `openclaw
   gateway call` use is an advanced/headless recovery surface rather than the
   ordinary approval path.
4. Thunderbird presents `requestId.claimSecret` once to
   `POST /thunderclaw/pairing/v1/claim`. The registry transaction consumes the
   approved request and creates the device verifier. A replay fails closed.
5. Product requests present `credentialId.deviceSecret` as a bearer value.
   Authentication checks the verifier, expiry, revocation state, and the exact
   route capability before dispatch.
6. Rotation authenticates the current credential, accepts a newly generated
   ID and verifier, creates the replacement, and revokes the old credential in
   one transaction. The extension must persist the replacement before
   discarding the old raw credential and must fail closed on an ambiguous
   result.
7. Self-revocation authenticates `credential:revoke`; operator revocation uses
   `thunderclaw.devices.revoke`. Disconnect revokes before deleting local
   custody when reachable. Forget deletes local custody and permission state
   even when remote revocation cannot be confirmed, and must clearly report
   that distinction.

The operator CLI never performs step 4: Claim is a separate Thunderbird action
that supplies the one-time claim secret held only by the extension. An approved
request cannot be denied or cancelled through protocol v1; it remains available
for Thunderbird to claim until its fixed expiry. The plugin-owned `openclaw
thunderclaw devices` commands administer ThunderClaw credential records and are
not OpenClaw core `openclaw devices`, which represents a different device and
pairing system.

The v1 device capabilities are status read, agent discovery/probe, compose and
message transformation, credential rotation, and credential revocation. They
do not authorize Gateway administration, arbitrary routes, tools, sending,
recipient/header/attachment changes, or model-produced HTML.

## Threats and required controls

| Threat | v1 control | Residual/qualification requirement |
| --- | --- | --- |
| Network capture or redirect | Remote origins require HTTPS; redirects are rejected; loopback HTTP is narrowly canonicalized | Qualify the supported remote HTTPS path and certificate failures |
| Request flooding | Per-source bounded window, bounded pending rows, bounded body and field sizes, short expiry and cleanup | Test concurrency, restart behavior, and proxy/source-address deployment assumptions |
| Guessing or replay | High-entropy claim/device secrets, short approval code used only with request identity, one-time transactional claim | Test wrong code, wrong claim, double approval/claim, and expiry boundaries |
| Registry theft | Only domain-separated verifiers and non-email metadata are stored; database/WAL/SHM use private POSIX modes on the tested Linux runtime | Secret-scan live files/logs, qualify backups/restores, and qualify Windows ACL behavior |
| Credential theft from a Thunderbird profile | Narrow per-device scope, expiry, rotation, independent revocation | This remains a profile-compromise risk; UI must support Disconnect and Forget |
| Stale or revoked authorization | Every request checks credential state and exact capability; rotation/revocation are durable | Qualify old-token rejection and restart persistence |
| Hostile or corrupt filesystem | No symlink/non-regular database objects, private modes, integrity/schema checks, fail-closed availability, and validated backup-before-migrate | Continue corruption, hostile-filesystem, backup/restore, and Windows qualification |
| Plugin/Gateway privilege confusion | Public pairing, product HTTP, and operator Gateway methods are separate surfaces | Confirm the extension never obtains or transmits a Gateway credential |

## Versioning and failure semantics

Every pairing request carries `protocolVersion: 1`; unsupported versions and
unknown fields fail closed. An absent ID, malformed bearer, and incorrect
verifier are indistinguishable authentication failures. A correctly verified
credential receives explicit `CREDENTIAL_EXPIRED` or `CREDENTIAL_REVOKED`
lifecycle errors so Thunderbird can present the appropriate recovery UX.
Mutations are transactional and must not return success until durable.
Registry initialization, schema mismatch, corruption, unsafe
filesystem state, or malformed capability data makes pairing unavailable
rather than falling back to the development static token.

This document defines the v1 boundary. Release acceptance additionally needs
adversarial, concurrency, expiry, migration, corruption, backup/restore,
upgrade, real-Thunderbird, and supported HTTPS qualification. POSIX mode
enforcement is not a Windows ACL boundary; Windows ACL, reparse-point/junction,
and hostile-filesystem behavior remain explicit release gates.
