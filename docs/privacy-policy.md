# ThunderClaw privacy policy

> **Publication note:** The policy text itself, not only a link to it, should
> be entered in the Thunderbird Add-ons privacy-policy field.

**Effective date:** August 12, 2026

ThunderClaw provides reviewable, user-initiated writing and reading assistance
in Thunderbird. It consists of a Thunderbird extension and a separately
installed plugin for an OpenClaw Gateway chosen and configured by the user or
their organization. The ThunderClaw project does not operate a Gateway, model
provider, analytics service, or other service that receives extension data.

This policy explains what the ThunderClaw extension and plugin process. It does
not replace the privacy terms of the user's OpenClaw deployment, selected model
provider, or other installed Gateway plugins and hooks.

## Data processed and why

ThunderClaw transmits email content only when the user invokes a ThunderClaw
writing, translation, or summary action. It processes connection and
compatibility data when the user pairs, tests, or manages the connection and
when the extension checks the connected Gateway for available agents.

### Compose actions

When the user requests a writing action, ThunderClaw sends the following to the
configured OpenClaw Gateway so the selected agent and configured model can
generate the requested proposal:

- the selected text or other exact draft target;
- the entire visible authored draft body and any extracted quoted message
  history, used as context even though only the selected target can be changed;
- the message subject;
- To, Cc, and Bcc recipient names or addresses;
- the user's selected action and any custom instruction; and
- operational values needed to validate the response, such as request and run
  IDs, compose generation, target IDs, content hashes, limits, selected agent
  ID, and protocol version.

ThunderClaw reads additional compose state, including headers and attachment
metadata, locally to detect stale results before Apply. It does not send that
additional state to the OpenClaw transformation route. ThunderClaw does not
send attachment contents through that route.

### Displayed-message actions

When the user requests translation or summarization of a displayed message,
ThunderClaw sends the following to the configured OpenClaw Gateway so the
selected agent and configured model can return the requested translation or
summary:

- the entire visible rendered message body, represented as up to 400 visible
  text segments;
- the message subject and author;
- the requested action and applicable source or target language; and
- operational values needed to validate the response, such as request and run
  IDs, message and segment IDs or hashes, limits, selected agent ID, and
  protocol version.

This includes visible quoted history, signatures, and other visible text in the
rendered message. It excludes hidden content, scripts, styles, and attachment
contents. Apart from the subject and author, ThunderClaw does not send other
message headers through the displayed-message transformation route.

### Connection, pairing, and compatibility data

The extension exchanges the configured Gateway origin, random device,
credential, pairing, request, and probe identifiers, a user-visible device
name, secret verifiers, approval and lifecycle state, protocol and capability
information, and selected agent/provider/model compatibility information with
the configured OpenClaw Gateway. This data is necessary to pair and
authenticate the extension, restrict it to ThunderClaw routes and capabilities,
recover safely from interrupted credential operations, list compatible agents,
and test compatibility.

The raw paired device credential authenticates only the ThunderClaw extension
to the configured Gateway. The extension does not receive or store model
provider credentials or a broad OpenClaw operator credential.

## Where data goes

The extension sends the data described above directly to the OpenClaw Gateway
origin that the user configures. Remote origins must use HTTPS; unencrypted
HTTP is allowed only for canonical loopback addresses on the same computer.

For a requested writing, translation, summary, or compatibility operation, the
Gateway passes the prepared prompt to the selected configured OpenClaw agent
and model provider. Agent workspace context that OpenClaw supplies, including
configured personality or memory context, may also be included in the model
request. A configured fallback model provider may receive the same content if
a fallback attempt is needed.

Other plugins and hooks installed in the user's OpenClaw Gateway are within
that deployment's trusted boundary. They may be technically able to observe or
modify prompts and agent-run events. Gateway operators should use a controlled
profile if they require a narrower boundary.

ThunderClaw does not send this data to a service operated by the ThunderClaw
developer. ThunderClaw has no advertising or analytics integration, does not
place or read cookies, and does not sell personal data. The project does not
receive the user's email content, credentials, or operational data merely
because the extension is installed or used.

The user or their organization chooses and controls the Gateway, agents,
providers, and hooks. Those parties process data under their own configuration,
terms, and privacy policies. ThunderClaw cannot control their use, location,
logging, model-training, disclosure, or retention practices. Users should
review those practices before sending sensitive or regulated mail content.

## Storage and retention

### In Thunderbird

The extension keeps active compose/message captures, generated proposals, and
validation state in memory while needed for the current Thunderbird context.
It does not intentionally save email bodies, prompts, or model responses in
extension persistent storage.

Thunderbird extension storage may persist:

- the configured Gateway origin and its granted host permission;
- a random device ID and user-visible device name;
- the narrow raw paired credential, its ID and expiry;
- temporary pairing, credential-rotation, revocation-recovery, connection
  generation, lifecycle, and permission-cleanup records needed for safe
  recovery after interruption; and
- the selected agent ID and preferred message translation language.

This storage is in the user's local Thunderbird profile. It is not a secure
vault independent of that profile: a person or program that compromises the
profile may obtain the paired credential and configuration. Thunderbird and
the operating system control profile files and backups.

Disconnect attempts to revoke the active Gateway credential and remove the
extension's host permission. Forget removes local connection credentials and
connection settings even if remote revocation cannot be confirmed. Some
non-email preferences and random device/lifecycle identifiers can remain until
extension storage is cleared or the extension is uninstalled. Copies in
Thunderbird or operating-system backups follow the user's backup retention.

### In the ThunderClaw OpenClaw plugin

The plugin uses caller-owned, in-memory agent sessions for ordinary
transformations. ThunderClaw does not deliberately write ordinary email
prompts, model output, or transformation transcripts to its pairing or
compatibility stores or to ordinary OpenClaw session transcripts.

The plugin persists pairing and credential metadata in the Gateway's private
plugin state. This includes random request, device, and credential IDs; the
device name; domain-separated secret verifiers rather than raw secrets;
capabilities; state and timestamps for creation, expiry, use, rotation, and
revocation; and revocation reasons. Completed or expired pairing requests are
pruned on a bounded schedule. Credential and revocation records may remain so
the Gateway can enforce credential lifecycle and audit its pairing state.

The plugin also persists bounded compatibility-probe records, including probe
and agent IDs, configuration fingerprints, configured and observed provider
and model names, check outcomes, and timestamps. OpenClaw itself may retain
opaque session or run identifiers as operational lifecycle data. These records
are not intended to contain email text or model output.

The Gateway operator controls the plugin-state files, logs, backups, installed
hooks, and their retention. Revoking or forgetting a connection does not erase
third-party provider records, Gateway logs, hook records, or backups. Requests
to access or delete those records must be directed to the operator or provider
that controls them.

### Model providers and other Gateway components

Model providers and installed Gateway components may log or retain prompts,
email content, responses, identifiers, or other operational data according to
the user's configuration and those parties' terms. Their retention may outlast
the in-memory ThunderClaw operation. ThunderClaw does not promise deletion from
systems it does not operate.

## User choice and control

ThunderClaw does not transmit email content passively or in the background.
The user chooses the Gateway origin, grants that origin's host permission,
pairs the extension, selects an agent, and invokes each writing, translation,
or summary action. Before pairing, the settings page describes the categories
of email content, destination, provider, and Gateway-hook access and requires
the user to affirmatively check a consent box. Pairing remains disabled without
that consent. The action UI also describes the email content that will be sent.

Generated writing remains a Preview until the user explicitly applies it.
ThunderClaw cannot send mail or change recipients, headers, or attachments.
Users may cancel active work, decline to Apply a result, Disconnect or Forget
the Gateway connection, revoke the origin permission in Thunderbird's Add-ons
Manager, revoke a credential through the Gateway operator, or uninstall the
extension. Disconnect or Forget withdraws the extension's recorded connection
state and stops future ThunderClaw email transmission unless the user consents
and pairs again; it cannot recall data already processed by a Gateway,
provider, hook, log, or backup.

## Security

ThunderClaw limits network calls to fixed product and pairing routes at the
configured origin, rejects redirects, bounds request and response sizes, and
uses a narrow per-device credential. Model-callable tools and trajectory are
disabled for ThunderClaw agent runs, and model output is validated on both
sides of the extension/Gateway boundary. No security measure eliminates all
risk, particularly if the Thunderbird profile, Gateway, model provider, or an
installed Gateway hook is compromised or misconfigured.

## Children

ThunderClaw is a general-purpose email productivity tool and is not directed
to children. The project does not knowingly operate a service that collects
personal data from children. A user's chosen Gateway or provider may impose
its own age or account requirements.

## Changes to this policy

This policy will be updated when ThunderClaw's data practices materially
change. The current policy and effective date will be published with the
Thunderbird Add-ons listing. An extension update that changes data transmission
will also follow applicable Thunderbird/Mozilla disclosure and consent
requirements.

## Contact

Privacy questions may be sent to [kris@wtsn.io](mailto:kris@wtsn.io). Do not
include private email content, credentials, approval codes, endpoint details,
or other secrets in a privacy inquiry.

---

## Thunderbird Add-ons listing privacy summary

> **Listing collateral — not part of the full policy.** Paste this summary into
> the add-on's Thunderbird Add-ons description near the feature description.

ThunderClaw sends email content only when you invoke a writing, translation, or
summary action. Compose actions send the selected text or exact draft target,
the entire visible authored draft body and extracted quoted message history,
subject, To/Cc/Bcc recipients, your action and custom instruction, plus
validation IDs and hashes. Displayed-message actions send the entire visible
rendered message body (including visible quoted history and signatures),
subject, author, requested languages, and validation IDs and hashes. This data
goes directly to the OpenClaw Gateway you configure, then to your selected
agent and configured model provider;
configured fallback providers and installed Gateway hooks may also process it.
ThunderClaw does not send attachment contents through its transformation
routes. Pairing stays disabled until you affirmatively consent to the disclosed
email-content transmission in ThunderClaw's settings.

The extension stores its Gateway configuration, random device and pairing
identifiers, narrow paired credential and recovery state, selected agent, and
language preference in your Thunderbird profile. It does not intentionally
persist email bodies or model responses. The ThunderClaw Gateway plugin stores
pairing/verifier and compatibility metadata, but not ordinary email or model
transcripts; OpenClaw may retain content-free operational IDs. Your Gateway,
provider, hooks, logs, and backups follow the retention and privacy choices of
you and those third parties. The ThunderClaw developer operates no data service
for the extension and receives no usage data, and ThunderClaw includes no
analytics, advertising, cookies, or sale of personal data. Read the full
privacy policy before use.
