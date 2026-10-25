# Liming Browser Direct v0.2.0

Code-review branch for a private ChatGPT browser-control plugin. Scope is synthetic browser testing and non-client engineering. This public repository must never contain client records, credentials, Chrome session data, Windows profile details, private tunnel configuration, or screenshots of real accounts.

Current published plugin: liming-browser-direct v0.2.0 (workspace private). Cloud Codex execution is not verified. Windows Chrome 9222 Xero integration is not verified.

Validation requirements: Node unit tests, synthetic Chromium CDP integration, negative-case checks for stale target and risky actions, idempotency/rollback review, actual source readback, and independent post-state verification. Preserve existing CCOS and no live installation or submissions.

Design references: ECC TDD / verification-loop / security-review; existing Liming Core engineering Skills. This file records review scope, not a deployable tunnel.
