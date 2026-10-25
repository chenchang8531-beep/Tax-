# v0.3.1 testing & evidence gates

1. **Source:** every packaged file matches `SHA256_MANIFEST.json`, no secrets, the single private Plugin ID remains unchanged; all old files retained unless independently reviewed.
2. **Local unit/negative tests:** explicit browser input actions, batch typing with value-readback, wrong client/period anchors, stale revision, high-risk control/Enter key, changed Windows owner/profile, save/reload mismatch, WAL corruption, uncertain action no replay.
3. **Isolated Chromium CDP:** exact input+click+Save and risk gate on a synthetic browser that does not use real 9222. Time measurements are synthetic only.
4. **Tunnel synthetic E2E:** cloud gateway HTTP long polling, separate agent/frontend/local tokens, exact device pin, remote MCP tool request, response matching, no CDP exposure, no replay on uncertain local writes, authentication/TLS denials.
5. **GitHub CI:** Linux Node 22/24 isolated Chromium plus Tunnel tests; Windows Node 22 controller, attestation mock and Tunnel tests. Source code presence and CI are not a native Codex Cloud task receipt.
6. **Real Windows:** current :9222 PID/exe/`--user-data-dir` and optional profile directory from the machine; verify current Chrome owner not a stale monitor. New 59422 localhost listener, privately stored secrets and local WAL. No writes until exact owner check matches.
7. **Real HTTPS/private host:** actual Gateway TLS certificate, distinct agent/front tokens, real outbound Windows Agent and host-visible MCP `browser_status`/`tabs` tools. A published private plugin manifest with empty `mcpServers` fails this gate.
8. **Xero Draft:** exact legal entity, FY and return, source-backed input, Save action readback and full reload/re-read via `browser_verify_saved`; no Lodge/Submit/Send/Pay/Sign/Delete.
9. **Deep Review/release:** independent negatives, rollback and authorisation boundaries, stale-result rejection and whole-chain acceptance; all required reality gates must pass before calling this a Live production capability.
