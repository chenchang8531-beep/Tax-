# ECC engineering source pin and limits (25 October 2026)

Authoritative public source: https://github.com/affaan-m/ECC
Observed latest repository commit from live GitHub: `90606c8315ee09cafc303515c5f33024db6b9882` (2026-10-20T21:28:23Z).
Selected reference skills: `skills/tdd-workflow/SKILL.md`, `skills/verification-loop/SKILL.md`, `skills/security-review/SKILL.md`; MIT-licensed upstream.
This package did **not** install ECC or copy its agents, hooks, credentials, remote commands or automatic learning. It only applies TDD RED/GREEN, verification-loop, regression/synthetic CDP E2E and security gate methods to the original plugin's own implementation. No ECC version is claimed as installed locally.

Source-first evidence: baseline 0.1.0 23/23 node tests. The new upgrade test initially failed before implementation (RED), then 37/37 total tests pass (GREEN), including real isolated Linux Chromium CDP with synthetic `about:blank` HTML. `node --experimental-test-coverage --test test/*.test.mjs`: combined line 91.91%, branch 76.59%; module-specific coverage in recorded logs. No real Windows Chrome 9222, Tunnel, Xero client, user Chrome profile or native Codex Cloud task was controlled for this source test.

Security exclusions for GitHub: passwords, tokens, user identifiers, browser CDP targets outside loopback, cookie stores, profile paths, client names/TFNs, local Windows install state, live Xero data, Tunnel keys, and private config MUST NOT be published. A public code branch, if used as a staging compromise, contains only generic runtime and synthetic fixtures; it is not the private deployment repository requested in the earlier Cloud Codex work packet. Do not merge into tax app main or auto-deploy.
