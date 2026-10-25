# v0.4.0 architecture and adversarial review — status REVIEW_READY_NOT_LIVE

**User correction incorporated:** no comprehensive client/FY/form identity check on every normal input. Full initial/final verification + exception-triggered complete revalidation; only cheap tab ID, route/document token and browser-side DOM watcher during uninterrupted actions.

## Test and design controls

- Positive: two synthetic client scopes concurrently own distinct Chrome CDP targets and keep numbers separate; first and final full identity checks only; Save/reload proof required; exact tab closed on verified finish.
- Negative: wrong FY, entity, form, organization, returnRef, duplicate task under changed descriptive matter, copied task ID, restart, partial fill, altered tab URL, same-URL DOM takeover, uncertain close, unsaved changes, and blocked pre-bind typing. All fail closed.
- Durability: append-only fsync task lease journal and separate action WAL store only scope hash, random task/target IDs, state and safe result metadata. On crash no automatic duplicate tab or replay.
- Security: independent current Chrome process attestation on task open/recovery/final (no OS probe each field); per action lightweight active target check and DOM watcher; allowed Xero origins, high-risk stop, no credentials/MFA; external CCOS operator conflict requires shared lock or isolation for Live.

## Explicit false-green controls

1. Synthetic Chromium plus unit tests are not evidence for real Windows 9222 owner, real Xero field meanings, host MCP resolver, cloud tunnel deployment, Xero persisted returns or cross-operator single-writer collaboration.
2. Same-name client pages are not authority: bind requires independent verified stable references, exact organisation and unique return ID plus visible anchors.
3. A completed UI Save or closed Tab alone is not accounting/tax completion. Only source-backed figures, correct return/form, independent Xero Draft persistence and specialist QA can establish readiness.
4. Frontend's current project.context_binding for non-client backend operations remains unverified; do not evade with a client mapping or fake revision.

Outcome: SOURCE_IMPLEMENTED; SYNTHETIC_VERIFICATION_REQUIRED; WINDOWS/TUNNEL/XERO_LIVE_OPEN. A separate live readback / independent domain verifier is still required.
