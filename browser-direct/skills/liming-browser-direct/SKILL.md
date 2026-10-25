---
name: liming-browser-direct
description: Control an authorised Chrome 9222 Xero Tax or Accounting task using one newly created task-owned Tab per exact client, legal entity, financial year, form and return. Use for browser open/bind, fast form entry, per-field readback, pause/resume, multi-client Tab isolation and final Save/reload and exact-tab closure, only when the private MCP runtime is genuinely connected.
---
# Liming Browser Direct v0.4.0

## Owners and live gates

The existing Liming Executive owns decisions and permissions; Xero Tax/Accounting/Payroll Skills own tax/accounting treatment; this Skill owns only safe, deterministic browser operations. This private plugin package does not prove a Server/Tunnel/host MCP tool is connected. Verify actual tool exposure and authenticated Windows Chrome 9222 Profile before browser write.

## User-corrected identity frequency

Do **one comprehensive initial identity bind**, **normal uninterrupted fast entry without rechecking client/FY/form identity per field**, and **one comprehensive final identity/readback before closing**. During normal actions, use only the exact owned Tab target ID, a lightweight document/route token, event-driven DOM identity-change watcher and field-value comparisons. Full identity check on exceptions only: pause/resume, error, lost/replaced Chrome target, unexpected navigation/DOM takeover, interruption, stale scope, process restart or verified user correction. Do not invent repeated checks as safety; do not remove cheap continuity guards.

## Action sequence

1. Confirm exact Project + opaque client/legal entity references, `entity`, `entityType`, FY/statement `period`, `formType`, Xero organisation ID/display label, specific `returnRef` and matter from verified sources. Never store TFNs, bank accounts, credentials or raw tax values in task IDs or journals.
2. Call `browser_task_open({scope,startUrl})` to create a unique dedicated Xero Tab. Never adopt an arbitrary existing tab or use the currently active Chrome window. The persistent ownership ledger prevents same-return duplicate sessions while allowing **different clients at the same time**.
3. For initial navigation use only `browser_task_prepare` / `browser_task_navigate` with an explicit, safe Xero URL/link and idempotency; no pre-bind form mutation. Call `browser_task_bind` once when the exact return is visible, with named `anchors:{client,year,form,organization,returnRef}`. All five anchors must reconcile to the selected task. Save `taskId`, owned `tabId` and `sessionId` in the task continuation.
4. Use `browser_fill_fields` (up to 12 exact selectors) or `browser_act` on the bound session without full identity scanning per step. For high-risk controls, stop. Exact per-field readback, selection validation, idempotent WAL and no blind retries remain mandatory. If a DOM identity watcher or Tab/document token indicates drift, halt immediately; use `browser_task_resume` for full revalidation. A benign browser or tool observation is not tax-form verification.
5. A Save click needs an explicit observed `POSTSTATE_VERIFIED` receipt. `browser_verify_saved` then reloads the exact owned return and checks persisted values (not only visible unsaved inputs). Once the form is complete, `browser_task_finish` performs final full client/FY/form/org/return verification and final expected field audit. It may auto-close **only its own** Tab after success; other clients' Tabs remain untouched.
6. `browser_task_pause` retains the dedicated Tab without allowing writes. On process crash use `browser_task_recover` only for the exact persistent task ID/Tab/scope with fresh identity evidence. Unresolved errors/identity/close outcomes stay OPEN; never generate duplicate return tabs or replay an uncertain Save/Lodge.

## Hard stops

No Lodge/Submit/Send/Pay/Sign/Delete, registrations, credentials, MFA or uncontrolled API writes. Do not assume private tab journal controls other independent CCOS/CDP operators; coordinate external single-writer ownership before Live. See `references/action-contract.md`, `references/integration.md`, and plugin root `docs/TAB_TASK_BINDING.md`.
