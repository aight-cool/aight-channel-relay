# Aight Channel Relay

Cloudflare Worker + Durable Objects WebSocket relay for [Aight](https://aight.cool) ↔ Claude Code channels.

Pairs an **Aight Channel Plugin** (running on a user's laptop) with the **Aight iOS app** via a cloud relay. No LAN discovery, no port forwarding — it just works.

## Architecture

```
┌──────────────┐    stdio     ┌──────────────────┐
│  Claude Code │◄────────────►│ Aight Channel    │
│  (laptop)    │              │ Plugin (MCP)     │
└──────────────┘              └────────┬─────────┘
                                       │ WSS
                                       ▼
                              ┌──────────────────┐
                              │ channels.aight.cool │
                              │ (this worker)    │
                              │ Durable Objects  │
                              └────────┬─────────┘
                                       │ WSS
                                       ▼
                              ┌──────────────────┐
                              │  Aight App       │
                              │  (iPhone)        │
                              └──────────────────┘
```

## Endpoints

| Method | Path                                        | Description                                                          |
| ------ | ------------------------------------------- | -------------------------------------------------------------------- |
| `GET`  | `/`                                         | Health check                                                         |
| `POST` | `/pair`                                     | Plugin requests a pairing code → `{ code, sessionToken, sessionId }` |
| `GET`  | `/ws/plugin?session=<token>&id=<sessionId>` | Plugin WebSocket                                                     |
| `GET`  | `/ws/app?code=<code>`                       | App WebSocket (first-time pairing)                                   |
| `GET`  | `/ws/app?session=<token>&id=<sessionId>`    | App WebSocket (reconnect)                                            |

## Pairing Flow

1. Plugin calls `POST /pair` → gets `{ code: "123456", sessionToken, sessionId }`
2. Plugin displays the 6-digit code in Claude Code terminal
3. Plugin connects to `/ws/plugin?session=<token>&id=<sessionId>`
4. User enters code in Aight app
5. App connects to `/ws/app?code=123456`
6. Relay pairs the two, sends `{ type: "paired" }` to both
7. Messages flow bidirectionally

## Message Protocol

| Direction    | Type                   | Payload                                                      |
| ------------ | ---------------------- | ------------------------------------------------------------ |
| Plugin → App | `reply`                | `{ type: "reply", id, content, timestamp }`                  |
| App → Plugin | `message`              | `{ type: "message", content, id, sender: { name, device } }` |
| Both         | `ping` / `pong`        | `{ type: "ping" }` / `{ type: "pong" }`                      |
| Relay → Both | `paired`               | `{ type: "paired", sessionToken? }`                          |
| Relay → Both | `partner_connected`    | `{ type: "partner_connected" }`                              |
| Relay → Both | `partner_disconnected` | `{ type: "partner_disconnected" }`                           |

## Development

```bash
npm install
npm run dev          # wrangler dev (local)
npm run typecheck    # TypeScript check
npm run test         # Vitest
```

## Secrets

```bash
wrangler secret put RELAY_SECRET   # HMAC signing key for session tokens
```

## Deploy

```bash
npm run deploy
```

Then configure `channels.aight.cool` as a custom domain in the Cloudflare dashboard.

## License

MIT
