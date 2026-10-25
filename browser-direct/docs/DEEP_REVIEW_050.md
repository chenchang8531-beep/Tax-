# v0.5.0 Design/Deep Review response to v0.4.0 release hold

v0.4.0's independent review showed false-green scenarios. Changes are owner-specific and do not replace the independent review's evidence.

| Review failure | v0.5.0 mechanism / test | Reality status |
|---|---|---|
| Concurrent duplicate task/action | OS-atomic per-resource and per-action claims + serialized journal + restart fail-closed tests | SOURCE TESTED, LIVE OPEN |
| Project/client alias bypass | Tenant and Return canonical resource key, independent of Project/matter alias | SOURCE TESTED, exact real Xero mapping OPEN |
| Header A remains while active form switches to B | Browser-side active form/identity DOM watcher; when active node changes it marks dirty | ISOLATED CHROMIUM TESTED, live Xero selector OPEN |
| Reload discards watcher | Require new document timeOrigin, recheck identity and reinstall watcher before following actions | SYNTHETIC TESTED; live Xero backend persistence OPEN |
| 12 fields falsely close full Return | Mandatory frozen multi-section plan/checkpoints, unique Save/reload receipt per section, UI state only, independent Ed25519 tax review before close | SYNTHETIC TESTED; real review service OPEN |
| No Return ID before new-return creation | Provisional client/FY/form claim, controlled create draft preflight, atomic promote on observed Return ID | SYNTHETIC TESTED; actual Xero evidence OPEN |
| TLS spoof via X-Forwarded-Proto | Real TLS socket/certificate required, untrusted forwarded header ignored | SYNTHETIC TESTED, external cloud deployment OPEN |
| Volatile Gateway request state | fsync Gateway journal for queued/dispatched/replied/timedout and no replay after restart | SYNTHETIC TESTED, durable volume OPEN |
| Old Project revision enters new action | Required compiler binding, production pluggable independent metadata verifier per batch; absent => block | BINDING UNAVAILABLE in current runtime |
| Multiple Chrome operators | Production requires external one-writer broker attest; absent => block; private registry cannot lock CCOS | BROKER INTEGRATION OPEN |
| Dangerous generic Confirm | Draft action intent allowlist, not keyword-only blocklist | SOURCE TESTED, Xero semantic mapping OPEN |

Remaining scope/permission and reality constraints prohibit `WHOLE_MODEL_SYNCED` or production completion. v0.4.0 remains rollback candidate. The PR must remain Draft until current host source/consumer readback and external verifier are implemented and exercised. Continue stable ID `LIMING-BROWSER-DIRECT-20261025`.
