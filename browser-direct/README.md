# Liming Browser Direct v0.3.1 — Full source model

A **single existing Liming Executive** controls a private Windows Chrome Xero workspace via a separately installed CDP actuator and an independently authenticated outbound reverse tunnel. The transport has **no AI planner** and never edits tax rules. Existing Xero Tax, Accounting and Payroll Skills retain source-backed tax/accounting decisions. **This is real executable source, not proof of a connected Live Xero browser.**

## Three executable components

1. **Windows Controller:** `runtime/src/mcp-server.mjs` listens **127.0.0.1:59422**, exposes 8 MCP tools (`status`, `tabs`, `bind`, `observe`, `act`, `fill_fields`, `verify_saved`, `release`) and drives Chrome's local `127.0.0.1:9222` CDP. Current Chrome owner PID and exact `--user-data-dir` / optional `--profile-directory` are rechecked from Windows OS **for every write**. A copied `PROFILE_ATTESTED=1` variable cannot grant control.
2. **Windows Outbound Agent:** `tunnel/agent.mjs` polls a private HTTPS gateway and forwards one request to the loopback MCP server. It retries **result posting only**; a possibly executed browser action is never replayed blindly.
3. **Cloud Gateway:** `tunnel/gateway.mjs` is a small, stateless-in-persistence request broker. Run a single instance behind a trusted TLS-terminating proxy with distinct frontend and agent secrets and exact agent ID. It does **not** expose Chrome CDP or any filesystem. In-memory pending requests are lost on restart and must be reconciled with the durable local action WAL, not replayed.

## Expected workflow

`ChatGPT frontend + existing tax Skills -> connected private MCP plugin -> HTTPS Gateway -> Windows outbound agent -> loopback MCP -> Chrome CDP:9222 -> Xero Draft -> exact readback after Save/reload`.

The controller acts only on explicit frontend instructions. One batch accepts 1–12 exact selected fields in one CDP connection. It validates a fresh page revision and 2+ exact source/target anchors, blocks high-risk controls/credentials/form Enter submission, does not automatically submit or lodge, and verifies every input twice. `FIELD_VALUES_VERIFIED_UNSAVED` is not a saved Draft. A separate `browser_verify_saved` command requires an observed same-session Save action then reloads and checks persisted field values. Uncertain outcomes and mismatches stop instead of restarting the action.

## Install and security boundary

- Run tests: from `runtime/` use `npm test` and `npm run test:coverage` (no install; Node 22+). Linux Chromium E2E uses **a separate synthetic browser**, never the user's :9222 process.
- Stage side-by-side on Windows with `scripts/Install-Windows-Stage.ps1`, verify hash manifest and use `scripts/Start-Windows-Controller.ps1` after identifying the exact intended Chrome; no existing CCOS installation is overwritten.
- Deploy the `tunnel/Dockerfile` container to a trusted private HTTPS cloud endpoint with two **different** secrets. Run `scripts/Save-Windows-Agent-Token.ps1` and `scripts/Start-Windows-Agent.ps1` after authenticating that endpoint. The public GitHub branch contains no secrets.
- Bind the actual HTTPS URL and private host-side Bearer credentials to the **same** Workspace plugin ID. Root `mcp.json` intentionally remains `mcpServers={}` until that authenticated deployment is verified; source publication alone cannot create host MCP tools.
- Use only an explicit Xero Draft/client/period scope after actual frontend tool exposure. No automatic Save/Lodge/Submit/Send/Pay/Sign/Delete, no credential/MFA handling and no uncontrolled page automation.

Read `docs/INSTALL_WINDOWS.md`, `docs/TUNNEL_DEPLOY.md`, `docs/VERIFICATION.md`, and `docs/CONTINUATION.json` for exact gates, rollback and outstanding reality evidence. This does not create another Agent, re-pair existing CCOS, or grant new authority.
