# Deep Review v0.3.1 — CI repair candidate

Observed GitHub run for v0.3.0: Linux Node 22 PASS; Windows Node 22 FAIL because /usr/bin/chromium integration test was included in test:unit; Node 24 initial status pending. No browser production test or client data effect was performed. v0.3.1 changes only the Windows test selection and consistent version labels, preserving the browser integration in Linux full coverage. Require independent GitHub run readback of all three jobs, Plugin Creator source hash readback, and Windows Chrome PID / private Tunnel / frontend MCP / Xero Draft real-host gates.

Result: SOURCE_REPAIR_PREPARED; REALITY_OPEN until recheck.
