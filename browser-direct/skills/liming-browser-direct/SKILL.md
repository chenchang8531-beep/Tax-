---
name: liming-browser-direct
description: Execute a frontend-authorised Xero Tax, Accounting or Payroll Draft in an exclusively owned Chrome 9222 tab, bound to exact client, Xero organisation, FY, form and Return ID. Use for provisional creation, rapid field entry, full return coverage tracking, interruption recovery, persisted Save/reload verification, independent review and guarded tab closure when the actual private MCP runtime is connected.
---
# Liming Browser Direct v0.5.0

## Authority and live gating

Liming Executive owns user intent and scope. Xero AU Tax Operations owns obligations, forms, return placement/rollups and tax QA; this Skill owns only the browser actuator. Never infer a working Windows/Tunnel connection from Plugin installation, GitHub tests or a healthy CCOS port. Require current authenticated front-end MCP tools, exact Project `context_binding`, live Chrome 9222 PID/profile attestation, a shared one-writer broker and actual browser readback before production writes. Absent any gate => BLOCKED for that branch. No Lodge, Submit, Send, Sign, Pay, Delete, passwords/MFA or hidden API actions.

## Frequency of identity verification

1. Initial complete identity verification: exact client/legal entity, organisation, FY/period, form family and Return ID; install watcher on **active return form DOM** only. A header outside the active form cannot prove identity.
2. Uninterrupted fast work: reuse the task-owned target ID, lightweight route/document/guard status and exact per-field value readback. No comprehensive client scan before every field or click. Independently verify Project revision metadata per batch without a full page identity scan.
3. After pause, error, changed tab/document/form, browser restart or changed Project revision: stop, recover the exact lease, verify full identity and reinstall the scoped watcher. On Save/reload verify a **new document** and reinstall watcher before continuing.
4. After all planned sections: final full identity and persisted field audit. This is UI-only; do not call the entire return complete until a separate tax domain verifier signs a matching plan/coverage receipt.

## Mandatory workflow

- First freeze the exact task scope: `project`, safe `clientRef`, `legalEntityRef`, `entity`, `entityType`, `fy`, `period`, `formType`, `matter`, canonical `xeroOrgRef`, `xeroOrgLabel`, and `returnRef` plus current Project binding. For a new return use `PENDING_RETURN` and retain evidence of exact current obligation and duplicate search.
- `browser_task_open` creates a plugin-owned new Tab; atomic canonical resource claim excludes Project labels and aliases. Never adopt somebody else's Xero Tab. A second writer with an already claimed organisation/Return must not proceed.
- For a new return, use `browser_task_create_return` only after independently verified obligation + no duplicate evidence, then `browser_task_promote_return` once actual new Return ID is visible in the route. Absent verification stop; never invent a Return ID.
- `browser_task_bind({taskId,anchors,formGuard})` must use named identity anchors and a unique `formGuard:{formSelector,identitySelector,identityText}` pointing **inside the active form** for production CDP. `browser_task_plan` freezes all required return section IDs and an authoritative source-workpaper version.
- Fill in small batches with `browser_fill_fields` or safe `browser_act`, source-backed precise field types and idempotency. `browser_verify_saved` requires a verified same-session Save and **new loader/document** readback; `browser_task_checkpoint` associates a planned section with a distinct persisted verification receipt. Never reuse the same Save/reload receipt across different sections.
- `browser_task_finish({taskId,expectedFields,closeTab:false})` verifies final visible identity/values only after all mandatory sections are checkpointed. It returns `UI_AUDIT_COMPLETE_AWAITING_DOMAIN_REVIEW`, leaves Tab open, and is NOT tax outcome DONE. `browser_task_review_approve` accepts only a cryptographically verified receipt signed by the independent Xero Tax domain review owner, matching task/coverage digests. Only then may `browser_task_close` close and re-read the exact plugin-created Tab target.
- Resume by `browser_task_pause/resume/recover` only from exact durable task ID/lease. An unconfirmed write, journal corruption, old Project binding, takeover or unknown return identity stays OPEN; never auto-replay it.

## Deployment details

See `references/action-contract.md`, `references/integration.md`, and the plugin root `docs/TAB_TASK_BINDING.md`, `docs/TUNNEL_DEPLOY.md`, `docs/VERIFICATION.md`. The private gateway must present genuine TLS, have a durable journal, distinct frontend/agent/local credentials and an authenticated ChatGPT connector. Source package and CI PASS are not Windows Live proof.
