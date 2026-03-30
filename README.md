# Aight Channel Relay

Cloudflare Worker + Durable Objects WebSocket relay for [aight.cool](https://aight.cool).

Pairs an **Aight Channel Plugin** (MCP server running alongside Claude Code on a laptop) with the **Aight iOS app** through a cloud relay. No LAN discovery, no port forwarding — it just works.

## Architecture

```
┌──────────────┐    stdio     ┌──────────────────┐
│  Claude Code │◄────────────►│ Aight Channel    │
│  (laptop)    │              │ Plugin (MCP)     │
└──────────────┘              └────────┬─────────┘
                                       │ WSS
                                       ▼
                              ┌──────────────────┐
                              │  Channel Relay   │
                              │  (this worker)   │
                              │                  │
                              │  ┌────────────┐  │
                              │  │ChannelRoom │  │
                              │  │   (DO)     │  │
                              │  └────────────┘  │
                              │                  │
                              │  ┌────────────┐  │
                              │  │  Pairing   │  │
                              │  │  Registry  │  │
                              │  └────────────┘  │
                              └────────┬─────────┘
                                       │ WSS
                                       ▼
                              ┌──────────────────┐
                              │  Aight App       │
                              │  (iPhone)        │
                              └──────────────────┘
```

Each paired session gets its own **ChannelRoom Durable Object** that holds two WebSocket connections (plugin + app) and forwards messages bidirectionally. A single **Pairing Registry** DO maps one-time 6-digit codes to session IDs. DOs use the **Hibernation API** so idle sessions don't consume resources, and session state is **persisted to storage** so it survives eviction.

## How It Works

1. **Plugin calls `POST /pair`** — Worker creates a ChannelRoom DO and returns `{ code, sessionToken, sessionId }`.
2. **Plugin displays the 6-digit code** in the Claude Code terminal.
3. **Plugin connects** via `/ws/plugin` with its session token.
4. **User enters the code** in the Aight app.
5. **App connects** via `/ws/app?code=123456` — relay pairs both sides.
6. **Both sides receive `{ type: "paired" }`** — the app also gets its own session token for reconnection.
7. **Messages flow bidirectionally** — the relay forwards everything between plugin and app.
8. **On disconnect**, messages are buffered in memory (up to 10) and delivered on reconnect.
9. **After 30 minutes of inactivity**, the session is automatically cleaned up.

## API

| Method | Path         | Parameters                        | Description                                      |
| ------ | ------------ | --------------------------------- | ------------------------------------------------ |
| `GET`  | `/`          | —                                 | Health check                                     |
| `POST` | `/pair`      | —                                 | Request a pairing code + session token           |
| `POST` | `/revoke`    | `{ sessionToken, sessionId }`     | Revoke a session, close all connections          |
| `GET`  | `/ws/plugin` | `?session=<token>&id=<sessionId>` | Plugin WebSocket (or omit token for auth-via-WS) |
| `GET`  | `/ws/app`    | `?code=<code>`                    | App WebSocket — first-time pairing               |
| `GET`  | `/ws/app`    | `?session=<token>&id=<sessionId>` | App WebSocket — reconnect                        |
| `GET`  | `/ws/app`    | `?id=<sessionId>`                 | App WebSocket — auth-via-first-message           |

## Message Protocol

| Direction      | Type                   | Payload                                                     |
| -------------- | ---------------------- | ----------------------------------------------------------- |
| Relay → Client | `auth_required`        | `{ type: "auth_required" }` — prompt to authenticate via WS |
| Relay → Both   | `paired`               | `{ type: "paired", sessionToken?, sessionId? }`             |
| Relay → Client | `reconnected`          | `{ type: "reconnected", partnerConnected }`                 |
| Relay → Client | `waiting_for_pair`     | `{ type: "waiting_for_pair" }` — plugin waiting for app     |
| Relay → Both   | `partner_connected`    | `{ type: "partner_connected" }`                             |
| Relay → Both   | `partner_disconnected` | `{ type: "partner_disconnected" }`                          |
| Relay → Client | `error`                | `{ type: "error", message }` — auth or protocol error       |
| Both           | `ping` / `pong`        | `{ type: "ping" }` → `{ type: "pong" }`                     |
| Plugin → App   | _(any)_                | Forwarded as-is (JSON or raw text)                          |
| App → Plugin   | _(any)_                | Forwarded as-is (JSON or raw text)                          |

## Getting Started

```bash
# Clone the repository
git clone https://github.com/aight-cool/aight-channel-relay.git
cd aight-channel-relay

# Install dependencies
npm install

# Create a local dev secret
echo "RELAY_SECRET=your-dev-secret-here" > .dev.vars

# Start the dev server
npm run dev

# Run tests
npm test

# Full CI check (typecheck + lint + format + test)
npm run ci
```

## Deploy

```bash
# Set your Cloudflare account ID
export CLOUDFLARE_ACCOUNT_ID="your-account-id"

# Set the HMAC signing secret for production
wrangler secret put RELAY_SECRET

# Deploy to Cloudflare Workers
npm run deploy
```

Then configure a custom domain in the Cloudflare dashboard if desired.

## Security

- **HMAC-SHA256 session tokens** with constant-time comparison
- **One-time pairing codes** with 5-minute TTL, deleted after single use
- **Rate limiting** — `/pair` (3/10min/IP), code attempts (5/min/IP)
- **Origin-restricted CORS** — only known origins allowed for browser requests
- **Input validation** — all parameters validated against strict regexes before processing
- **Message size limit** — 1MB per WebSocket message
- **Session revocation** — `POST /revoke` closes all connections and deletes all state
- **Message buffer TTL** — buffered messages auto-expire after 12 hours, encrypted at rest

## Project Structure

```
src/
  index.ts              — Worker entry point, HTTP/WS router
  auth.ts               — HMAC token generation/validation, input regexes
  channel-room.ts       — ChannelRoom Durable Object
  rate-limit.ts         — In-memory rate limiter
  index.test.ts         — Worker integration tests
  channel-room.test.ts  — Durable Object unit tests
wrangler.toml           — Cloudflare Worker configuration
vitest.config.mts       — Test configuration (cloudflare pool)
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Run `npm run ci` to verify all checks pass
4. Open a pull request

## License

[MIT](./LICENSE) — Copyright (c) 2025 [aight.cool](https://aight.cool)
