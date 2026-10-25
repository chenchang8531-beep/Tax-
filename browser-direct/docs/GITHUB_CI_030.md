# GitHub CI v0.3.0 expected outcomes and replay safety

- CI must run `npm run test:coverage` from browser-direct/runtime on Linux Node 22/24 with standalone `/usr/bin/chromium` (isolated `--remote-debugging-port=0` and temporary user data directory). Run `npm run test:unit` on Windows Node 22. Do not access the logged-in Xero Chrome or any production site.
- Expected source baseline: 50 Node tests PASS, line coverage at least 80%, including local Gateway/Agent -> Chromium full-stack test (but no local HTTP/data navigation due to test container policy).
- CI PR is Draft. Any failing job blocks release-acceptance claims; inspect actual logs, repair root cause, and rerun. No skipped required tests or relaxing coverage to green.
- User secrets, Chrome owner process data, customer workpapers, screenshots, cookies and active tokens are forbidden in the public GitHub repository. Hashes/receipt metadata may be shared.
- Plugin publish from a source artifact requires guarded release_id, readback, same Plugin ID and exact source hashes; host installation is a separate gate.
