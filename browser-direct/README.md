# Liming Browser Direct v0.4.0 — multi-client isolated Chrome Xero task controller

One Liming frontend controls dedicated task-owned Chrome Tabs through local `127.0.0.1:9222` CDP, standalone Windows MCP on `127.0.0.1:59422`, outbound Windows Agent and private HTTPS Gateway. Source and installed private Plugin do not themselves prove that the runtime connection exists.

## Exact first bind, uninterrupted fast work, final verify

**User requirement:** do not fully verify customer identity on each step. `browser_task_open` creates a **new** tab for the exact client, legal entity, FY, return type, Xero organisation and unique return ID; `browser_task_bind` checks those five independent visible/URL anchors **once**. During a normal uninterrupted workflow, the controller uses its own Tab ID, document/return URL fingerprint, and event-driven DOM identity watcher, while verifying each entered value without expensive repeated client checks. On interruption, Chrome tab/route replacement, client DOM takeover, error, user correction or restart, `browser_task_resume`/`browser_task_recover` demands full revalidation. After a verified Save/reload, `browser_task_finish` confirms identity and values **once at the end**, then closes **only its own** tab.

## Components

- `runtime/src/controller.mjs`, `runtime/src/task-tabs.mjs`, `runtime/src/cdp-browser.mjs`: controlled CDP action engine, new-tab lifecycle, per-client/FY/form ownership, durable anti-duplicate lease, fast 1–12 field batch fill, no blind write retry, owner/session consistency and final verification.
- `runtime/src/mcp-server.mjs`: local authenticated JSON-RPC MCP endpoints (legacy unowned bind blocked in production). Requires independent Windows Chrome owner/profile attestation at task start, exception recovery and final completion, not per field. Dedicated per-task journal and action WAL.
- `tunnel/agent.mjs`, `tunnel/gateway.mjs`: independently authenticated outbound reverse HTTPS long poll; separate frontend and agent secrets, no published CDP, no client-data persistence in gateway.
- `scripts/`: isolated Windows version staging, local DPAPI secret handling, read-only process check, server/agent startup. Existing CCOS is not overwritten.

See `docs/TAB_TASK_BINDING.md` for exact tools, identity policy, concurrent client isolation and exception routing. `docs/INSTALL_WINDOWS.md`, `docs/TUNNEL_DEPLOY.md`, `docs/VERIFICATION.md` give installation, test and Live gates.

**Source tests and GitHub CI are not proof of a current Windows :9222 owner/profile, installed Server, connected private Tunnel, host MCP tool exposure, or real Xero Draft persistence.** The plugin never grants tax/legal authority and blocks Lodge/Submit/Send/Pay/Sign/Delete, credentials and MFA. The Xero Tax/Accounting/Payroll Skills remain the professional owners.
