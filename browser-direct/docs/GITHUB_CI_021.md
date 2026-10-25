# GitHub CI diagnostic — Liming Browser Direct v0.2.1

Initial GitHub Actions run `40184330695` for PR #1:
- Windows Node 22 unit: PASS.
- Linux Node 22 full synthetic Chromium CDP: PASS.
- Linux Node 24 full synthetic Chromium CDP: FAIL.

The failing job showed Chromium 155 was installed and runnable, but its isolated test instance did not write `DevToolsActivePort` inside the prior 7.5-second polling window. This is a bounded test-startup/liveness failure; it does not prove a defect in real Windows Chrome, nor does it prove Xero integration.

Changes in v0.2.1:
- Require actual isolated Chromium success; never skip the browser E2E check.
- Allow up to 30 seconds for bootstrap, still bounded by a 75-second test deadline.
- Capture bounded launch error/stderr for diagnosis and accept a test-only binary override.
- Enforce at least 80% Node line coverage in CI.

Acceptance still requires current GitHub Actions Linux Node 22/24 and Windows Node 22 readback. This public branch contains only synthetic code and tests; no credentials, private Tunnel bindings, client data, account cookies, local Chrome profile information or production screenshots.

Native Codex Cloud task, Windows Chrome 9222 profile attestation, private MCP HTTPS Tunnel, real frontend tool exposure and Xero Draft save/reload are separately OPEN. Do not merge to main or deploy to production from this source test alone.
