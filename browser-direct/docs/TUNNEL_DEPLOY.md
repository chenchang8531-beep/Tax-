# Independent HTTPS reverse Tunnel — deployable v0.3.1 source

## Security design

`ChatGPT private MCP -> HTTPS /mcp (frontend Bearer token) -> cloud gateway single replica -> authenticated /agent/next long poll -> Windows outbound HTTPS agent -> 127.0.0.1:59422/mcp -> Chrome 127.0.0.1:9222`.

Three different secrets and identities are used: `LIMING_GATEWAY_FRONTEND_TOKEN` (remote ChatGPT connector plus cloud gateway), `LIMING_GATEWAY_AGENT_TOKEN` (cloud gateway plus Windows agent), and `LIMING_BROWSER_TOKEN` (Windows agent plus local loopback MCP). Never use one secret for two roles. Cloud gateway also pins `LIMING_GATEWAY_AGENT_ID` to exactly one Windows agent. The long poll is an outgoing HTTPS connection from Windows; there is no port-forwarding, inbound firewall change or public CDP endpoint. The frontend token must be configured using private connector authentication, not committed inside `mcp.json`.

## Server deployment

Build the container from this package root: `docker build -f tunnel/Dockerfile -t liming-browser-gateway:0.3.1 .`. Supply secrets through the provider's secret manager. Set gateway listener to one replica, port 8080, with an HTTPS-terminating **trusted reverse proxy** that correctly sets `X-Forwarded-Proto: https` and restricts direct backend connections. The gateway requires that header in production and independently verifies Bearer credentials. It does not create TLS certificates by itself. Its `/healthz` is liveness only, `/status` is token-protected agent connectivity, and `/mcp` is token-protected stateless MCP JSON-RPC. Ensure the hosting provider supports persistent long-lived HTTP requests or use a provider with 30-second request allowances.

## Endpoint binding

Verify a real HTTPS DNS name, certificate and provider auth. Configure the real connector's URL to `https://<your-private-gateway>/mcp` and the private frontend token in its **host-managed connection secret**. Root `mcp.json` remains unbound until this is actually done; never copy a plaintext token into a shared plugin or GitHub. The ChatGPT host must genuinely expose the new MCP tool definitions after a fresh resolver reload. If the host's plugin connection does not support outbound Bearer authentication, use its supported OAuth/private connection mechanism or stop at `MCP_AUTH_BINDING_UNAVAILABLE`; do not strip auth.

## Failure semantics

- Missing Windows Agent: cloud gateway returns `AGENT_OFFLINE` (503), never fabricates success.
- Gateway overload: `BACKPRESSURE` (429), no automatic browser action replay.
- Agent-local / browser ambiguity: the agent returns `LOCAL_UNKNOWN_OUTCOME_DO_NOT_REPLAY`; reconcile the protected Windows WAL and actual page before repeating any write.
- Gateway 30-second response timeout: `UNKNOWN_OUTCOME_NO_AUTOREPLAY` (504); a late Agent response is accepted only as an observation, never as permission for another effect.
- Gateway restart loses volatile queue: preserve the client's exact action idempotency key and reconcile against the local WAL; do not derive new keys from retries.
- Auth/agent identity/TLS mismatch: fail closed, no fallback to the existing CCOS/Android tunnel or a second device.

## Acceptance layers

Test in a local isolated loopback first; CI synthetic Gateway/Agent proves source execution only. Real hosted Gateway + Windows Agent TLS session, ChatGPT tool exposure, exact Chrome profile owner and Xero Draft persistence each require independent receipts. No customer records, cookies, tokens, bank information or production screenshots are accepted as public GitHub evidence.
