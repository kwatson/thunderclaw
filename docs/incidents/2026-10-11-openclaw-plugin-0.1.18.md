# Unpublished OpenClaw plugin 0.1.18 recovery

The original [release run](https://github.com/kwatson/thunderclaw/actions/runs/38158337152)
failed all three attempts at the pairing readiness check after credential rotation
and Gateway restart. Each failure followed approximately 30 seconds of polling.
The same integration gate passed on the main CI retry with restart persistence at
approximately 28 seconds. The pre-tag exact-byte qualification and protected
real-agent qualification passed. No failed product assertion is waived.

The repaired harness uses a two-minute readiness deadline and a five-second HTTP
probe deadline. Startup readiness is retried; credential assertions remain blocking.
The repaired harness passed isolated integration against the original candidate.
Future failures emit only allowlisted container state, excluding logs and secrets.

A read-only audit on 2026-10-11 found no GitHub release, provenance attestation,
ClawHub version, or publisher run for `openclaw-plugin-v0.1.18`. All publication
jobs were skipped. The exact annotated tag object was
`9a190ccc537b10c930996e4980df23a75153ea13`, pointing to
`88a949dd0274e768cf25bea9679d92c55e0397a9`. The original candidate SHA-256 was
`7ca9115e25adea035b57e58fe59bb89ea97b9b35f74a739fce047428c3ac35cf`.
These absence checks must be repeated immediately before any authorized deletion.

Recovery preparation restores only the unshipped compatibility metadata to the
last-published 0.1.17 / OpenClaw 2026.9.9 baseline. After explicit maintainer
approval to replace the unpublished tag, the operator tool can create a fresh
reservation for unchanged OpenClaw 2026.10.1 and plugin 0.1.18. It requires every
gate again and builds a new candidate once; it cannot promote the failed attempt's
archive. No tag replacement or public completion is claimed by this record.
