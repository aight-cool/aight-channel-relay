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
 *   POST /messages/:sessionId     — HTTP catch-up for buffered messages
 *
 * WebSocket requests are forwarded to the DO using the ORIGINAL request
 * object — this is required to preserve Cloudflare's internal WebSocket
 * upgrade metadata. The DO parses routing from the original URL.
 */

import {
  generateSessionId,
  validateSessionToken,
  PAIRING_CODE_RE,
  SESSION_ID_RE,
  SESSION_TOKEN_RE,
} from "./auth";
import { isRateLimited, rateLimitResponse } from "./rate-limit";

export { ChannelRoom } from "./channel-room";

export interface Env {
  RELAY_SECRET: string;
  CHANNEL_ROOM: DurableObjectNamespace;
}

/**
 * CORS: Allow requests from the Aight app (native, no origin header)
 * and localhost for development. Block other origins.
 */
const ALLOWED_ORIGINS = new Set([
  "capacitor://localhost",
  "http://localhost",
  "http://localhost:8081",
  "http://localhost:19006",
]);

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin");
  // Native apps send no Origin header — allow those.
  // For browser requests, only allow known origins.
  const allowOrigin = !origin || ALLOWED_ORIGINS.has(origin) ? (origin ?? "*") : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// Note: jsonResponse doesn't have request context for CORS.
// WebSocket upgrades (the sensitive paths) don't use CORS anyway.
// This is defense-in-depth for the REST endpoints only.
function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: getCorsHeaders(request) });
    }

    // ── Health check ──
    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "aight-channel-relay",
        version: "0.2.0",
      });
    }

    // Guard: RELAY_SECRET must be configured
    if (!env.RELAY_SECRET) {
      return jsonResponse({ error: "Server misconfigured: RELAY_SECRET not set" }, 500);
    }

    // Client IP for rate limiting
    const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";

    // ── POST /revoke — Kill a session (M4: session revocation) ──
    if (url.pathname === "/revoke" && request.method === "POST") {
      try {
        const body = await request.json<{
          sessionToken: string;
          sessionId: string;
        }>();
        if (!body.sessionToken || !body.sessionId) {
          return jsonResponse({ error: "Missing sessionToken or sessionId" }, 400);
        }

        const valid = await validateSessionToken(
          env.RELAY_SECRET,
          body.sessionId,
          body.sessionToken,
        );
        if (!valid) {
          return jsonResponse({ error: "Invalid credentials" }, 403);
        }

        // Forward revoke to the DO
        const doId = env.CHANNEL_ROOM.idFromName(body.sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        const doResp = await stub.fetch(new Request("https://do/revoke", { method: "POST" }));
        return jsonResponse(await doResp.json());
      } catch {
        return jsonResponse({ error: "Invalid request body" }, 400);
      }
    }

    // ── GET /debug/push/:sessionId — check push state (temporary) ──
    const debugPushMatch = url.pathname.match(/^\/debug\/push\/([0-9a-f]{32})$/);
    if (debugPushMatch && request.method === "GET") {
      const sessionId = debugPushMatch[1];
      const doId = env.CHANNEL_ROOM.idFromName(sessionId);
      const stub = env.CHANNEL_ROOM.get(doId);
      const doResp = await stub.fetch(new Request("https://do/debug/push"));
      return jsonResponse(await doResp.json());
    }

    // ── POST /pair — Plugin requests a new pairing session ──
    if (url.pathname === "/pair" && request.method === "POST") {
      // Rate limit: 3 per 10 min per IP (prevents DO creation spam / denial-of-wallet)
      if (
        isRateLimited(`pair:${clientIp}`, {
          maxRequests: 3,
          windowMs: 10 * 60_000,
        })
      ) {
        return rateLimitResponse();
      }
      return handlePair(env);
    }

    // ── POST /messages/:sessionId — HTTP catch-up for buffered messages ──
    const messagesMatch = url.pathname.match(/^\/messages\/([0-9a-f]{32})$/);
    if (messagesMatch && request.method === "POST") {
      const sessionId = messagesMatch[1];

      // Rate limit: 5 per min per IP (same as /ws/app — prevents polling abuse)
      if (
        isRateLimited(`messages:${clientIp}`, {
          maxRequests: 5,
          windowMs: 60_000,
        })
      ) {
        return rateLimitResponse();
      }

      // Forward to the session's DO — auth happens inside getBufferedMessages
      const doId = env.CHANNEL_ROOM.idFromName(sessionId);
      const stub = env.CHANNEL_ROOM.get(doId);
      const doResp = await stub.fetch(
        new Request("https://do/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: request.headers.get("Authorization") ?? "",
          },
          body: request.body,
        }),
      );

      // Forward DO response with CORS headers
      const respData = await doResp.json();
      return jsonResponse(respData, doResp.status);
    }

    // ── GET /ws/plugin — Plugin WebSocket ──
    if (url.pathname === "/ws/plugin" && request.method === "GET") {
      const sessionToken = url.searchParams.get("session");
      const sessionId = url.searchParams.get("id");

      if (sessionToken && sessionId) {
        if (!SESSION_TOKEN_RE.test(sessionToken) || !SESSION_ID_RE.test(sessionId)) {
          return jsonResponse({ error: "Invalid parameter format" }, 400);
        }
        // Legacy: token in URL (backwards compat)
        const valid = await validateSessionToken(env.RELAY_SECRET, sessionId, sessionToken);
        if (!valid) {
          return jsonResponse({ error: "Invalid session token" }, 403);
        }
        const doId = env.CHANNEL_ROOM.idFromName(sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        return stub.fetch(request);
      }

      if (sessionId) {
        if (!SESSION_ID_RE.test(sessionId)) {
          return jsonResponse({ error: "Invalid parameter format" }, 400);
        }
        // New: token-free URL — auth happens over WS as first message
        const doId = env.CHANNEL_ROOM.idFromName(sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        return stub.fetch(request);
      }

      return jsonResponse({ error: "Missing id parameter" }, 400);
    }

    // ── GET /ws/app — App WebSocket (pairing or reconnect) ──
    if (url.pathname === "/ws/app" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const sessionToken = url.searchParams.get("session");

      if (code) {
        if (!PAIRING_CODE_RE.test(code)) {
          return jsonResponse({ error: "Invalid code format" }, 400);
        }
        // Rate limit: 5 per min per IP (prevents pairing code brute force)
        if (
          isRateLimited(`app-code:${clientIp}`, {
            maxRequests: 5,
            windowMs: 60_000,
          })
        ) {
          return rateLimitResponse();
        }

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
        // Legacy reconnect: token in URL
        const sessionId = url.searchParams.get("id");
        if (!sessionId) {
          return jsonResponse({ error: "Missing id parameter" }, 400);
        }

        const doId = env.CHANNEL_ROOM.idFromName(sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        return stub.fetch(request);
      }

      // New: token-free URL — just session ID, auth via first WS message
      const sessionId = url.searchParams.get("id");
      if (sessionId) {
        const doId = env.CHANNEL_ROOM.idFromName(sessionId);
        const stub = env.CHANNEL_ROOM.get(doId);
        return stub.fetch(request);
      }

      return jsonResponse({ error: "Missing code, session, or id parameter" }, 400);
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

  if (!doResponse.ok) {
    const err = await doResponse.text();
    return jsonResponse({ error: `Session init failed: ${err}` }, 500);
  }

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
