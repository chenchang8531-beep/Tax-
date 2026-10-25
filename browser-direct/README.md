# Liming Browser Direct v0.5.0 — GitHub source / private Plugin candidate

A frontend-directed Xero Chrome 9222 browser actuator with one exact Xero organisation/Return per plugin-created Tab, exception-only comprehensive identity checks, per-field fast batch input and verified draft Save/reload. Domain and tax decisions remain with existing Liming/Xero Skills.

## Improvements since v0.4.0 independent Deep Review

- Cross-process atomic canonical Return claims and action idempotency; crash state fails closed.
- Scoped active-form identity watcher instead of page-wide header substring; reinstalled on fresh document after Save/reload.
- Provisional new-return creation supported with evidence-bound promotion to actual Return ID.
- Full frozen return section checklist with distinct Save receipts; final UI checkpoint is **not** a complete tax return. Independent signed Xero Tax review required before owned Tab close.
- Metadata Project stale-result verifier and external one-writer broker are mandatory production integration gates; no fabricated fallback.
- Genuine end-to-end TLS Gateway, durable request journal/restart status, no replay of uncertain effects, draft action allowlist.

## How to test

`cd runtime && npm run test:coverage` or `npm run test:unit` (Windows). Staging instructions in `docs/INSTALL_WINDOWS.md`; deployment in `docs/TUNNEL_DEPLOY.md`; all Live blocks in `docs/DEEP_REVIEW_050.md`.

**Not a production-connected system by package publication alone.** The existing CCOS Tunnel remains intact; new private MCP host resolver / Windows service / real Xero Draft must be independently verified. No Lodge/Submit/Send/Sign/Pay/Delete or client-data usage in source tests.
