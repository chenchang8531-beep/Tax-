# GitHub CI v0.3.1 — Windows unit isolation correction

Root cause of first v0.3.0 CI failure: Windows test:unit used a tunnel/test/*.test.mjs wildcard, accidentally including full-stack.cdp.test.mjs which requires /usr/bin/chromium. That is a platform-specific browser integration test and must run only in Linux CDP jobs. The Windows test:unit command now names reverse-tunnel.test.mjs explicitly, retaining all Windows-safe unit, gateway, security, replay and persistence tests. Full-stack Chromium still runs on Linux Node 22 and 24 with NO skip, because test:coverage continues to include both tunnel test files. The new script is a source change and requires Plugin Creator version 0.3.1 and fresh GitHub CI green before accepted.

Do not infer Windows 9222 physical browser safety, Tunnel deployment, native Cloud Codex, ChatGPT tool exposure or Xero Draft persistence from CI.
