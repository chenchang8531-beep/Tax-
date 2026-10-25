# v0.4.0 testing & evidence gates

1. **Source:** every packaged file matches `SHA256_MANIFEST.json`, no secrets, the single private Plugin ID remains unchanged; all old files retained unless independently reviewed.
2. **Local unit/negative tests:** explicit browser input actions, batch typing with value-readback, wrong client/period anchors, stale revision, high-risk control/Enter key, changed Windows owner/profile, save/reload mismatch, WAL corruption, uncertain action no replay.
3. **Isolated Chromium CDP:** exact input+click+Save and risk gate on a synthetic browser that does not use real 9222. Time measurements are synthetic only.
4. **Tunnel synthetic E2E:** cloud gateway HTTP long polling, separate agent/frontend/local tokens, exact device pin, remote MCP tool request, response matching, no CDP exposure, no replay on uncertain local writes, authentication/TLS denials.
5. **GitHub CI:** Linux Node 22/24 isolated Chromium plus Tunnel tests; Windows Node 22 controller, attestation mock and Tunnel tests. Source code presence and CI are not a native Codex Cloud task receipt.
6. **Real Windows:** current :9222 PID/exe/`--user-data-dir` and optional profile directory from the machine; verify current Chrome owner not a stale monitor. New 59422 localhost listener, privately stored secrets and local WAL. No writes until exact owner check matches.
7. **Real HTTPS/private host:** actual Gateway TLS certificate, distinct agent/front tokens, real outbound Windows Agent and host-visible MCP `browser_status`/`tabs` tools. A published private plugin manifest with empty `mcpServers` fails this gate.
8. **Xero Draft:** exact legal entity, FY and return, source-backed input, Save action readback and full reload/re-read via `browser_verify_saved`; no Lodge/Submit/Send/Pay/Sign/Delete.
9. **Deep Review/release:** independent negatives, rollback and authorisation boundaries, stale-result rejection and whole-chain acceptance; all required reality gates must pass before calling this a Live production capability.

## v0.4.0 multi-client identity + dedicated Tab acceptance

- Initial explicit task scope must include client/legal entity references, FY/period, Xero organisation ID + name, form family, Xero returnRef and matter. Separate named anchors must be visible/verified. No fuzzy matching, list position or active Chrome tab selection.
- `browser_task_open` creates a brand-new CDP target and stores immutable ownership. Different clients' tasks can run concurrently on different Tab IDs. Same return (even with changed memo text) refuses duplicate open, including across process restart.
- Full identity checks count = 1 at bind, then 0 during a normal batch, then 1 at finish. Lightweight URL/document ID and event-driven DOM identity replacement watchers keep the Tab safe without expensive per-field scans. A paused, crashed, overwritten, navigated, wrong-client/year/org/form/return Tab blocks until full revalidation.
- Complete Save/Reload/Final field verification before closure. Auto-close must only close the exact created Tab and verify it disappeared; all pre-existing and other clients' Tabs remain. After unknown close ACK or tab replacement stop, do NOT auto close a candidate by URL/name.
- Real isolated Chrome exercises two tasks, actual `/json/new`, per-client input isolation, same-URL customer header replacement detection and `/json/close` owned-only. Live Xero selectors, cross-CCOS writer cooperation, app connector availability and signed client/business decision are separate gates.
