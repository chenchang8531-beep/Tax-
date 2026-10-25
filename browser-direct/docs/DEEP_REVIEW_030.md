# Deep Review v0.3.0 — source-only review, not a live-host verdict

## Outcome against user request
The source now contains a complete transport path: frontend MCP connector interface (unbound until host credentials exist), HTTPS-edge cloud reverse Gateway, Windows outbound Agent, local MCP Server with CDP 9222 actuator, and versioned Windows staging scripts. It is **not fully deployed** because the real HTTPS endpoint, current Windows owner/profile and current compiler Project binding are not proven. No Xero client data was touched.

## Verified executable evidence
- Node unit/security/persistence/tunnel tests include wrong identity, wrong origin, stale revisions, changes after fast fill, form Enter, frozen WAL, ambiguous write, mismatched Save/reload, bearer auth, wrong Agent ID and TLS rejection.
- Isolated Chromium actual CDP input/click/risk guard is independently exercised; one synthetic test sends MCP via cloud Gateway and outbound Agent before reaching Chrome.
- Full persistence verification through Page.reload has a deterministic mocked browser test. Container Chromium policy returns `net::ERR_BLOCKED_BY_ADMINISTRATOR` for localhost and data navigation, so **real Chromium reload persistence test cannot be claimed** in this environment. This reality gap remains part of Windows staging acceptance.
- GitHub CI for the previous release passed all 3 OS/runtime jobs; v0.3.0 requires its own independent CI run and hash readback.

## Safety architecture / failure modes
- Chrome exact current PID, executable and user-data-dir from the Windows OS are rechecked for each write. A static attestation environment flag is never trusted by the production server. The script is not actually executed on the user's Windows host in this source review.
- The cloud Gateway requires private HTTPS reverse proxy and distinct frontend/agent tokens, and never forwards :9222 publicly. Trusted-edge TLS termination must be verified at the actual provider; `X-Forwarded-Proto` alone is not cryptographic proof if the origin is directly reachable.
- Gateway queue is in memory, one active agent poll and one instance. A restart loses pending work; the persistent local action WAL owns the replay prohibition, not the cloud queue. A timed-out request is `UNKNOWN_OUTCOME` and is never automatically reissued by tunnel code.
- The UI risk regex and two anchors reduce obvious high-risk/cross-client errors but are not a substitute for Xero professional judgment or explicit authority. `browser_verify_saved` checks only listed fields after Save/reload, not accounting correctness or tax law.
- Existing CCOS keepalive may refresh a managed Xero tab while a user edits it. Do not use a managed production tab before single-writer arbitration or an isolated test tab is demonstrated.

## Independent verdict
SOURCE_IMPLEMENTED / SYNTHETIC_TESTED; LIVE_REALITY_OPEN. Do not label whole model SYNCED. Required gates: native Windows process probe and real browser action, current Project compiler context binding, HTTPS Gateway deployment + outbound Agent, host private MCP tool exposure, and authorized Xero Draft Save/reload. Keep GitHub PR draft and preserve the prior 0.2.1 Plugin release for rollback.
