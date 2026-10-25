# Dedicated Xero task Tab ownership — v0.4.0

## User-corrected operational policy

**Full client/FY/form identity verification exactly at initial binding and final completion.** Do not recheck the whole customer identity on every field or click. During uninterrupted work use only owned CDP Tab ID, fast document token/URL and event-driven DOM identity watcher. Per-field value checking is still required because a successful input event does not prove a correct amount.

**Force full identity revalidation only when paused/resumed, a browser error occurs, another page/return overlays or replaces the Tab, the Tab disappears, the document loads anew, the user or frontend changes scope, or the browser controller restarts.** A failed idempotent write is not automatically retried.

## One task = one exact return + one plugin-created Tab

Task scope requires `project`, opaque `clientRef`, opaque `legalEntityRef`, legal `entity`, `entityType`, `fy`, `period`, `formType`, `matter`, opaque `xeroOrgRef`, exact `xeroOrgLabel`, and stable Xero `returnRef`. No TFN, password, bank account or cookie is accepted in identity references. Tax form types include ITR, CTR, TRT, PTR, SMSF, FBT, BAS/IAS, annual BAS; accounting and payroll have their own types. Existing Xero Tax owning Skills still decide obligations and return creation.

`taskDigest` excludes descriptive matter spelling to stop accidental duplicated ownership of the same exact return. Durable JSONL task journal stores only hashed scope, random task ID, Chrome target ID and state; it stores **no client name, tax amount or raw form data**. A crash leaves an unfinished lease until exact-owner recovery is verified. It never blindly opens a duplicate Tab.

## Ordered tools

1. `browser_task_open({scope,startUrl})` — reserve exact hashed identity and create a **new** approved Xero Tab with Chrome CDP `/json/new` (PUT), returning its unique `taskId` and `tabId`. No existing Xero Tab is adopted.
2. If the return URL is not reached yet, use `browser_task_prepare` or `browser_task_navigate` to navigate only within the newly-created unbound Tab. Before identity binding, permitted actions are exact Xero URL navigation, safe labelled Xero links, scroll and wait; NO typing or form buttons.
3. `browser_task_bind({taskId,anchors:{client,year,form,organization,returnRef}})` — one comprehensive check of exact legal entity name, FY, form family, Xero organisation label and unique return ID (URL or text). Installs event-driven DOM identity watcher and freezes the actual CDP Tab ID/document fingerprint. Returns `sessionId`.
4. Use `browser_fill_fields`, `browser_act` and `browser_observe` on the same managed session. **No full client identity check each field.** Skip full-page scans in the batch fast path. Lightweight target ID / URL / document token / DOM-identity-change flag catches unexpected takeover. Still check every entered value, target uniqueness and dangerous controls.
5. On pause, route drift, page replacement, error or restart: stop. `browser_task_resume` (same process) or `browser_task_recover` (exact journaled tab after restart) conducts one fresh complete identity check; a different client or return must hard-fail.
6. After Save (same-session `POSTSTATE_VERIFIED` click), call `browser_verify_saved` to reload and verify persisted actual values. `browser_task_finish({taskId,expectedFields,closeTab:true})` then performs **the final full identity check** and value comparison, closes ONLY that exact plugin-owned Chrome target via `/json/close`, and returns VERIFIED_AND_CLOSED only on actual close readback. A changed target, unsaved amount, missing evidence or uncertain close remains OPEN/REVIEW and is not automatically replayed.

## Multiple simultaneous matters

Different exact task digests may own different Tab IDs concurrently; actions are serialized **per Tab**, not globally. Same return/FY/form refuses duplicate opening. A Tab cannot be rebound across tasks, and a task cannot be silently moved to a new target ID. The pre-existing Xero/client Tabs of other workers are never auto-closed. Underlying CCOS and other Chrome operators are not guaranteed to honour this plugin's private ownership ledger: true cross-operator single-writer safety remains a Windows Live integration gate.

## Remaining reality boundary

The source tests cover two concurrent synthetic customers, wrong FY/form/org/return, controlled reopen after pause, same-URL DOM page takeover, crash recovery, and restricted close. They do not prove Xero live selectors, native Cloud Codex execution, a bound host MCP transport, or a successful real Xero Draft save/reload. Production must continue blocking Lodge, Submit, Send, Sign, Pay and Delete.
