/**
 * Aight Channel Relay — Cloudflare Worker
 *
 * Stateless WebSocket relay that pairs an Aight Channel Plugin (running on
 * the user's laptop alongside Claude Code) with the Aight iOS app.
 *
 * Endpoints:
 *   GET  /                        — Health check
 *   POST /pair                    — Plugin requests a pairing code
 *   GET  /ws/plugin?session=<tok>&id=<id> — Plugin WebSocket connection
 *   GET  /ws/app?code=<code>      — App WebSocket connection (first pair)
 *   GET  /ws/app?session=<tok>&id=<id>    — App WebSocket reconnection
 *
 * WebSocket requests are forwarded to the DO using the ORIGINAL request
 * object — this is required to preserve Cloudflare's internal WebSocket
 * upgrade metadata. The DO parses routing from the original URL.
 */

import { generateSessionId, validateSessionToken } from "./auth";

export { ChannelRoom } from "./channel-room";

export interface Env {
  RELAY_SECRET: string;
  CHANNEL_ROOM: DurableObjectNamespace;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Health check ──
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "aight-channel-relay",
        version: "0.1.1-ws-fix",
      });
    }

    // ── POST /pair — Plugin requests a new pairing session ──
    if (url.pathname === "/pair" && request.method === "POST") {
      return handlePair(env);
    }

    // ── GET /ws/plugin — Plugin WebSocket ──
    if (url.pathname === "/ws/plugin" && request.method === "GET") {
      const sessionToken = url.searchParams.get("session");
      const sessionId = url.searchParams.get("id");
      if (!sessionToken || !sessionId) {
        return jsonResponse({ error: "Missing session or id parameter" }, 400);
      }

      const valid = await validateSessionToken(env.RELAY_SECRET, sessionId, sessionToken);
      if (!valid) {
        return jsonResponse({ error: "Invalid session token" }, 403);
      }

      const doId = env.CHANNEL_ROOM.idFromName(sessionId);
      const stub = env.CHANNEL_ROOM.get(doId);

      // Use two-arg form: stub.fetch(url, request) — passes the original
      // request as RequestInit, which preserves CF's WebSocket metadata.
      // Pattern from CF's own chat demo: roomObject.fetch(newUrl, request)
      const doUrl = new URL(request.url);
      doUrl.pathname = "/ws/plugin";
      return stub.fetch(doUrl.toString(), request);
    }

    // ── GET /ws/app — App WebSocket (pairing or reconnect) ──
    if (url.pathname === "/ws/app" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const sessionToken = url.searchParams.get("session");

      if (code) {
        // Pairing: look up session ID from code, then forward
        const registryId = env.CHANNEL_ROOM.idFromName("__pairing_registry__");
        const registry = env.CHANNEL_ROOM.get(registryId);
        const lookupResp = await registry.fetch(new Request(`https://do/lookup-code?code=${code}`));
        if (!lookupResp.ok) {
          return jsonResponse({ error: "Invalid or expired pairing code" }, 403);
        }
        const { sessionId } = await lookupResp.json<{ sessionId: string }>();

        const doId = env.CHANNEL_ROOM.idFromName(sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        // Two-arg form preserves WebSocket upgrade metadata from request
        return stub.fetch(url.toString(), request);
      }

      if (sessionToken) {
        // Reconnect
        const sessionId = url.searchParams.get("id");
        if (!sessionId) {
          return jsonResponse({ error: "Missing id parameter" }, 400);
        }

        const doId = env.CHANNEL_ROOM.idFromName(sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        return stub.fetch(url.toString(), request);
      }

      return jsonResponse({ error: "Missing code or session parameter" }, 400);
    }

    // Debug: minimal WebSocket test route
    if (url.pathname === "/ws-test" && request.method === "GET") {
      const doId = env.CHANNEL_ROOM.idFromName("ws-test");
      const stub = env.CHANNEL_ROOM.get(doId);
      return stub.fetch(request);
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

// ── /pair handler ──

async function handlePair(env: Env): Promise<Response> {
  const sessionId = generateSessionId();

  const doId = env.CHANNEL_ROOM.idFromName(sessionId);
  const stub = env.CHANNEL_ROOM.get(doId);

  const doResponse = await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      body: JSON.stringify({ pluginSessionId: sessionId }),
      headers: { "Content-Type": "application/json" },
    }),
  );

  const { code, sessionToken } = await doResponse.json<{ code: string; sessionToken: string }>();

  // Store code → sessionId mapping in the pairing registry DO
  const registryId = env.CHANNEL_ROOM.idFromName("__pairing_registry__");
  const registry = env.CHANNEL_ROOM.get(registryId);
  await registry.fetch(
    new Request("https://do/register-code", {
      method: "POST",
      body: JSON.stringify({ code, sessionId }),
      headers: { "Content-Type": "application/json" },
    }),
  );

  return jsonResponse({ code, sessionToken, sessionId });
}
