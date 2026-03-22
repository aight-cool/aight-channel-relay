/**
 * Aight Channel Relay — Cloudflare Worker
 *
 * Stateless WebSocket relay that pairs an Aight Channel Plugin (running on
 * the user's laptop alongside Claude Code) with the Aight iOS app.
 *
 * Endpoints:
 *   GET  /                        — Health check
 *   POST /pair                    — Plugin requests a pairing code
 *   GET  /ws/plugin?session=<tok> — Plugin WebSocket connection
 *   GET  /ws/app?code=<code>      — App WebSocket connection (first pair)
 *   GET  /ws/app?session=<tok>    — App WebSocket reconnection
 */

import { generateSessionId, generateSessionToken, validateSessionToken } from "./auth";

export { ChannelRoom } from "./channel-room";

export interface Env {
  RELAY_SECRET: string;
  CHANNEL_ROOM: DurableObjectNamespace;
}

/** CORS headers for all responses */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: CORS_HEADERS,
  });
}

/**
 * Map pairing codes → Durable Object IDs.
 *
 * We use a separate DO instance keyed by "codes" that acts as an in-memory
 * registry. But that's heavy — instead we derive the DO ID deterministically
 * from a session ID and keep a lightweight in-memory code→sessionId map in
 * the worker. Since workers are ephemeral, we actually store the mapping
 * as part of the DO itself and do a two-step lookup.
 *
 * Simpler approach: the plugin gets back a sessionId from /pair.
 * The app sends the pairing code. We need to map code → DO.
 *
 * Strategy: Use a "lookup" DO keyed by "pairing-codes" to store
 * the code → sessionId mapping. Lightweight and auto-cleans.
 */

// We'll use a simple approach: derive DO name from sessionId for sessions,
// and use a global "pairing-registry" DO for code lookups.

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Health check ──
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({ ok: true, service: "aight-channel-relay", version: "0.1.0" });
    }

    // ── POST /pair — Plugin requests a new pairing session ──
    if (url.pathname === "/pair" && request.method === "POST") {
      return handlePair(env);
    }

    // ── GET /ws/plugin?session=<token> — Plugin WebSocket ──
    if (url.pathname === "/ws/plugin" && request.method === "GET") {
      const sessionToken = url.searchParams.get("session");
      if (!sessionToken) {
        return jsonResponse({ error: "Missing session parameter" }, 400);
      }
      return handlePluginWebSocket(request, env, sessionToken);
    }

    // ── GET /ws/app?code=<code> — App WebSocket (pairing) ──
    // ── GET /ws/app?session=<token> — App WebSocket (reconnect) ──
    if (url.pathname === "/ws/app" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const sessionToken = url.searchParams.get("session");

      if (code) {
        return handleAppPairWebSocket(request, env, code);
      }
      if (sessionToken) {
        return handleAppReconnectWebSocket(request, env, sessionToken);
      }
      return jsonResponse({ error: "Missing code or session parameter" }, 400);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// ── /pair handler ──

async function handlePair(env: Env): Promise<Response> {
  const sessionId = generateSessionId();

  // Create a DO instance for this session
  const doId = env.CHANNEL_ROOM.idFromName(sessionId);
  const stub = env.CHANNEL_ROOM.get(doId);

  // Initialize the session in the DO
  const doResponse = await stub.fetch(new Request("https://do/init", {
    method: "POST",
    body: JSON.stringify({ pluginSessionId: sessionId }),
    headers: { "Content-Type": "application/json" },
  }));

  const { code, sessionToken } = await doResponse.json<{ code: string; sessionToken: string }>();

  // Store code → sessionId mapping in the pairing registry DO
  const registryId = env.CHANNEL_ROOM.idFromName("__pairing_registry__");
  const registry = env.CHANNEL_ROOM.get(registryId);
  await registry.fetch(new Request("https://do/register-code", {
    method: "POST",
    body: JSON.stringify({ code, sessionId }),
    headers: { "Content-Type": "application/json" },
  }));

  return jsonResponse({ code, sessionToken, sessionId });
}

// ── Plugin WebSocket handler ──

async function handlePluginWebSocket(
  request: Request,
  env: Env,
  sessionToken: string,
): Promise<Response> {
  // The session token encodes the session — we need to find which session.
  // The plugin must also pass sessionId so we can look up the DO.
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("id");
  if (!sessionId) {
    return jsonResponse({ error: "Missing id parameter" }, 400);
  }

  // Validate token
  const valid = await validateSessionToken(env.RELAY_SECRET, sessionId, sessionToken);
  if (!valid) {
    return jsonResponse({ error: "Invalid session token" }, 403);
  }

  // Forward to the DO
  const doId = env.CHANNEL_ROOM.idFromName(sessionId);
  const stub = env.CHANNEL_ROOM.get(doId);

  const doUrl = new URL("https://do/ws");
  doUrl.searchParams.set("role", "plugin");
  doUrl.searchParams.set("token", sessionToken);

  return stub.fetch(new Request(doUrl.toString(), {
    method: "GET",
    headers: request.headers,
  }));
}

// ── App WebSocket (pairing) handler ──

async function handleAppPairWebSocket(
  request: Request,
  env: Env,
  code: string,
): Promise<Response> {
  // Look up the session ID from the pairing registry
  const registryId = env.CHANNEL_ROOM.idFromName("__pairing_registry__");
  const registry = env.CHANNEL_ROOM.get(registryId);

  const lookupResp = await registry.fetch(new Request(`https://do/lookup-code?code=${code}`));
  if (!lookupResp.ok) {
    return jsonResponse({ error: "Invalid or expired pairing code" }, 403);
  }

  const { sessionId } = await lookupResp.json<{ sessionId: string }>();

  // Forward to the session DO
  const doId = env.CHANNEL_ROOM.idFromName(sessionId);
  const stub = env.CHANNEL_ROOM.get(doId);

  const doUrl = new URL("https://do/ws");
  doUrl.searchParams.set("role", "app");
  doUrl.searchParams.set("code", code);

  return stub.fetch(new Request(doUrl.toString(), {
    method: "GET",
    headers: request.headers,
  }));
}

// ── App WebSocket (reconnect) handler ──

async function handleAppReconnectWebSocket(
  request: Request,
  env: Env,
  sessionToken: string,
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("id");
  if (!sessionId) {
    return jsonResponse({ error: "Missing id parameter" }, 400);
  }

  // Forward to the DO — it will validate the app's token
  const doId = env.CHANNEL_ROOM.idFromName(sessionId);
  const stub = env.CHANNEL_ROOM.get(doId);

  const doUrl = new URL("https://do/ws");
  doUrl.searchParams.set("role", "app");
  doUrl.searchParams.set("token", sessionToken);

  return stub.fetch(new Request(doUrl.toString(), {
    method: "GET",
    headers: request.headers,
  }));
}
