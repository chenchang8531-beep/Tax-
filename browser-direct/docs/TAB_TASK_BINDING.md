# v0.5.0 — canonical multi-client Return and Tab ownership

## Invariants

- The **resource key** for an existing return is `hash(canonical Xero organisation ID + stable Return ID)`, independent of client alias, Project name or narrative matter. Never rely on list index or active foreground tab. Provisional new return locks are keyed to exact tenant+legal entity+FY+period+form before the real ID is observable. Promotion from provisional to exact uses the same durable journal and a new atomically claimed resource.
- One Windows Tab is created by the plugin for one task. Different returns may work in different Tabs, but only the browser owner controller writes to a given target. Current CCOS/external Chrome operators must coordinate via a verified exclusive broker: a private file lock is not sufficient to exclude actors which do not honour it.
- Atomic directories acquired before writing journal records provide unique claims across processes sharing one Windows lock root. Interrupted lock acquisition is *not* auto reclaimed. Same-key action reservation is equally atomic and never rerun after uncertain result. Existing v0.4.0 JSONL files are not silently imported as safe v0.5.0 locks; a controlled migration/reconciliation is mandatory.
- One complete identity at bind; no repeated expensive identity scan during normal uninterrupted filling. Active-form identity guard tracks the actual form container and its own identity element, not document.body text. Lost monitor, changed form or document requires exception revalidation.
- On reload require a **new document** plus identity revalidation and watcher reinstallation, while subsequent batches still use cheap probe. Saved DOM values are not automatically proof of server-side tax correctness.
- `browser_task_finish` checks all frozen section persistence receipts and final scoped identity. It produces UI-only checkpoint. Independent tax review requires Ed25519 signature over immutable resource/coverage digests; no signature => Tab remains unclosed. No generic Confirm/Continue/OK click in production Draft mode.

## Failure modes

`RESOURCE_LEASE_HELD`, `RESOURCE_LEASE_STALE`, `TASK_GUARD_UNAVAILABLE`, `TASK_REVALIDATION_REQUIRED`, `FULL_RETURN_COVERAGE_MISSING`, `COVERAGE_REUSED_SAVE`, `INDEPENDENT_VERIFIER_UNAVAILABLE`, `CONTEXT_VERIFIER_UNAVAILABLE`, `WRITER_BROKER_UNAVAILABLE`, `GATEWAY_JOURNAL_CORRUPT` all stop the affected action. Never reinterpret the same unresolved state as success.
