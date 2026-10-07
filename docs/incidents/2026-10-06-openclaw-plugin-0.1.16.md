# OpenClaw plugin 0.1.16 release recovery — 2026-10-06

## Outcome and limits

ThunderClaw plugin 0.1.16 for OpenClaw 2026.9.8 was published on GitHub and
ClawHub. Both ClawHub scans were clean, and strict public verification confirmed
canonical notes, source identity, and byte equality with the qualified archive.
The extension counterpart remained 0.1.2. The baseline was merged and durable
state reached `complete`, revision 30. Internal repairs created no 0.1.17 release.

The controller successfully qualified, merged, and tagged the compatibility
candidate. ClawHub publication needed protected manual recovery using reviewed
automation on main. The corrected automatic OIDC publisher was not exercised
end to end by that manual success. Later completion-event repairs passed CI but
still need an actual future closeout event or sandbox exercise.

## Evidence

- [Successful pre-tag qualification](https://github.com/kwatson/thunderclaw/actions/runs/37529475352)
- [Automatic merge and tag handoff](https://github.com/kwatson/thunderclaw/actions/runs/37530603261)
- [Original release run, historical overall failure](https://github.com/kwatson/thunderclaw/actions/runs/37530809536)
- [Rejected automatic ClawHub submission](https://github.com/kwatson/thunderclaw/actions/runs/37534608543)
- [Successful protected manual publication](https://github.com/kwatson/thunderclaw/actions/runs/37538864005)
- [Successful exact-publication finalizer](https://github.com/kwatson/thunderclaw/actions/runs/37541893189)
- [Baseline closeout PR](https://github.com/kwatson/thunderclaw/pull/31)
- [Controller recovered merged closeout](https://github.com/kwatson/thunderclaw/actions/runs/37542100548)
- [Final controller correctly avoided a duplicate release](https://github.com/kwatson/thunderclaw/actions/runs/37542314903)
- [Final main CI](https://github.com/kwatson/thunderclaw/actions/runs/37542311925)
- [GitHub release](https://github.com/kwatson/thunderclaw/releases/tag/openclaw-plugin-v0.1.16)
- [Public package version API](https://clawhub.ai/api/v1/packages/%40thunderclaw%2Fopenclaw-plugin/versions/0.1.16)

Qualified archive: `thunderclaw-openclaw-plugin-0.1.16.tgz`, 108495 bytes,
SHA-256 `750d926ada1da59454282dc2b1ba0ee6e1233a9319d60f5ec06aa29fed45ac28`.
Immutable release commit: `5a26dc1e83129a8657d495e07921bbc95311cede`.

## Causes and corrections

| Failure | Correction and evidence |
| --- | --- |
| Thunderbird display collision before product trials | Isolated randomized display and bounded startup-only retry, [PR 15](https://github.com/kwatson/thunderclaw/pull/15). |
| Credentials removed before Compose shutdown | Cleanup ordering and executable failure/success regression, [PR 17](https://github.com/kwatson/thunderclaw/pull/17). |
| Verifier rejected reservation-suffixed candidate branch | Exact branch binding and producer result validation, [PR 19](https://github.com/kwatson/thunderclaw/pull/19). |
| Result job lacked checkout/runtime setup | Explicit per-job prerequisites, [PR 21](https://github.com/kwatson/thunderclaw/pull/21). |
| Native lock test exceeded a tight wall-clock bound | Direct configured-timeout assertion and runner tolerance, [PR 23](https://github.com/kwatson/thunderclaw/pull/23). |
| Release tests inherited enabled rollout setting | Environment-isolated assertions and enabled CI coverage, [PR 25](https://github.com/kwatson/thunderclaw/pull/25). |
| Publication handoff lacked repository/runtime setup | Shared authenticated publication finalizer, [PR 26](https://github.com/kwatson/thunderclaw/pull/26). |
| Public verification window too short for ClawHub | Longer bounded wait, retain submission result first, long-lived job token for reads, [PR 27](https://github.com/kwatson/thunderclaw/pull/27). |
| Automatic submission used short tag source ref | Full OIDC-matching ref and immediate known-rejection handling, [PR 28](https://github.com/kwatson/thunderclaw/pull/28). |
| Old-tag manual recovery used old public verifier | Load reviewed verifier from publisher workflow commit, [PR 29](https://github.com/kwatson/thunderclaw/pull/29). |
| Finalizer would repeat failed upload despite verified public version | Probe exact public bytes/source/notes/scans and skip upload, [PR 30](https://github.com/kwatson/thunderclaw/pull/30). |
| Scheduled recovery lacked prerequisites; closeout event rejected synthetic ref | Recovery setup and trusted-base closed-PR event, [PR 32](https://github.com/kwatson/thunderclaw/pull/32). |

The first automatic submission was rejected before entering the scan queue.
It was initially mistaken for a scan delay because the client warning was
swallowed and the public version stayed absent. The shared ClawHub batch
[37535946525](https://github.com/openclaw/clawhub/actions/runs/37535946525)
was not proof of our submission: our accepted recovery upload happened later.
Read acceptance evidence before explaining a missing version as slow scanning.

## Follow-up

The [release operations runbook](../release-operations.md) records the recovery
decision tree and recurring failure patterns. The [roadmap](../roadmap.md)
tracks unfinished enforcement, rehearsal, recovery, and observability work;
do not infer those improvements are implemented from this incident record.
