# AGENTS.md — Aight Channel Relay

## What This Is

Cloudflare Worker + Durable Objects WebSocket relay for [aight.cool](https://aight.cool).
Pairs an Aight Channel Plugin (MCP server running alongside Claude Code on a laptop)
with the Aight iOS app via a cloud relay. No LAN discovery, no port forwarding.

## Architecture

- **Worker** (`src/index.ts`): Stateless HTTP/WS router. Validates auth, rate-limits,
  and forwards requests to the correct Durable Object.
- **ChannelRoom DO** (`src/channel-room.ts`): One instance per paired session. Holds up
  to two WebSocket connections (plugin + app) and forwards messages bidirectionally.
  Uses the Hibernation API so idle DOs don't consume resources.
- **Pairing Registry DO**: A single DO instance named `__pairing_registry__` that maps
  one-time 6-digit pairing codes to session IDs. Codes are stored in DO storage and
  deleted after a single lookup.
- **Persistent Storage**: Session state (pairing code, session IDs, timestamps) is
  persisted to DO storage so it survives eviction. Message buffers are persisted to
  DO storage for offline delivery (12-hour TTL), encrypted at rest by Cloudflare.
- **Rate Limiting** (`src/rate-limit.ts`): In-memory sliding-window counters. Resets
  when the Worker isolate recycles. Applied to `/pair` and `/ws/app?code=` endpoints.

## Key Concepts

### Pairing Flow

1. Plugin calls `POST /pair` — Worker creates a new ChannelRoom DO, returns
   `{ code, sessionToken, sessionId }`.
2. Plugin connects via WebSocket with its session token.
3. User enters the 6-digit code in the Aight app.
4. App connects via `/ws/app?code=<code>` — relay pairs both sides, sends
   `{ type: "paired" }` to both.
5. Messages flow bidirectionally until disconnect.

### Session Tokens

HMAC-SHA256 over `"v1:" + sessionId` using `RELAY_SECRET`. Validated with
constant-time comparison. Both plugin and app get independent tokens.

### Auth-via-First-Message

For native apps that cannot set custom query parameters on WebSocket URLs,
the client connects without a token and sends `{ type: "auth", token: "..." }`
(or `{ type: "auth", code: "..." }`) as the first message. The server responds
with `{ type: "auth_required" }` on connect to prompt this.

### Message Buffering

When one side disconnects, messages from the other side are buffered in volatile
memory (up to 10 messages). Delivered on reconnect. Buffer is lost if the DO
evicts — this is intentional to avoid persisting user content.

### Auto-Cleanup

An alarm fires after 30 minutes of inactivity. The alarm closes any remaining
WebSocket connections and deletes all storage for the session.

## Endpoints

| Method | Path         | Description                               |
| ------ | ------------ | ----------------------------------------- |
| GET    | `/`          | Health check                              |
| POST   | `/pair`      | Request a pairing code + session token    |
| POST   | `/revoke`    | Revoke a session (requires token + ID)    |
| GET    | `/ws/plugin` | Plugin WebSocket (token in URL or via WS) |
| GET    | `/ws/app`    | App WebSocket (code, token, or via WS)    |

## Project Structure

```
src/
  index.ts              — Worker entry point, HTTP router
  auth.ts               — HMAC token generation/validation, input regexes
  channel-room.ts       — ChannelRoom Durable Object
  rate-limit.ts         — In-memory rate limiter
  index.test.ts         — Worker integration tests
  channel-room.test.ts  — Durable Object unit tests
wrangler.toml           — Cloudflare Worker config
vitest.config.mts       — Test config (cloudflare pool)
```

## Dev Commands

```bash
npm install             # Install dependencies
npm run dev             # Local dev server (wrangler dev)
npm test                # Run tests (vitest)
npm run ci              # Full CI: typecheck + lint + format + test
npm run typecheck       # TypeScript type checking
npm run lint            # ESLint
npm run format          # Prettier check
npm run format:fix      # Prettier fix
```

## Testing

Uses **Vitest** with `@cloudflare/vitest-pool-workers` for realistic Durable Object
testing. The test secret is `"test-secret"` (configured in `vitest.config.mts`).

Tests interact directly with DO stubs via `env.CHANNEL_ROOM` and with the Worker
via `SELF.fetch()`. WebSocket tests use `WebSocketPair` and manual `accept()`.

## Conventions

- **Strict TypeScript** — `strict: true` in tsconfig.
- **Prettier** — 100-char print width (check with `npm run format`).
- **ESLint** — recommended + typescript-eslint rules.
- **Input validation** — Use regexes from `auth.ts` (`PAIRING_CODE_RE`,
  `SESSION_ID_RE`, `SESSION_TOKEN_RE`) to validate user input before processing.
- **Generic error messages** — Never leak internal state in error responses.
  Use generic messages like "Invalid parameter format" or "Invalid credentials".

## Deployment

```bash
# Set your Cloudflare account ID
export CLOUDFLARE_ACCOUNT_ID="your-account-id"

# Set the HMAC signing secret
wrangler secret put RELAY_SECRET

# Deploy
npm run deploy
```

CI auto-deploys on push to `main` (configure in your CI provider).

## Security Model

- **HMAC-SHA256** session tokens with constant-time comparison.
- **One-time pairing codes** with 5-minute TTL — deleted after single use.
- **Rate limiting** — `/pair` (3 per 10 min per IP), `/ws/app?code=` (5 per min per IP).
- **Origin-restricted CORS** — Only `capacitor://localhost` and local dev origins.
  Native apps with no Origin header are allowed (defense-in-depth for REST endpoints).
- **Input validation** — All user-supplied parameters validated against regexes before
  processing. Malformed inputs rejected with 400 before reaching Durable Objects.
- **Message size limit** — 1MB max per WebSocket message.
- **Session revocation** — `POST /revoke` closes all connections and deletes all state.
