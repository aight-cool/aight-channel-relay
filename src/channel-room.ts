/**
 * ChannelRoom — Durable Object
 *
 * One instance per paired session. Holds up to 2 WebSocket connections
 * (plugin + app), forwards messages bidirectionally.
 *
 * Lifecycle:
 *   1. Plugin calls POST /pair → creates DO, gets pairing code + session token
 *   2. Plugin connects via WS with session token
 *   3. App connects via WS with pairing code → gets its own session token
 *   4. Messages flow bidirectionally
 *   5. Auto-cleanup when both sides disconnect
 */

import { DurableObject } from "cloudflare:workers";
import { generateSessionToken, generatePairingCode, validateSessionToken } from "./auth";

/**
 * Code → sessionId registry entry.
 * Used when this DO instance is the "__pairing_registry__".
 */
interface CodeEntry {
  sessionId: string;
  expiresAt: number;
}

interface SessionState {
  /** 6-digit pairing code (null after pairing or expiry) */
  pairingCode: string | null;
  /** When the pairing code expires */
  pairingExpiresAt: number | null;
  /** Session ID for the plugin side */
  pluginSessionId: string;
  /** Session ID for the app side (null until paired) */
  appSessionId: string | null;
  /** Whether pairing is complete */
  paired: boolean;
  // messageBuffer removed — kept in volatile memory only (see volatileBuffer)
  /** Timestamp of last activity */
  lastActivity: number;
}

interface BufferedMessage {
  from: "plugin" | "app";
  data: string;
  timestamp: number;
}

type WebSocketRole = "plugin" | "app";

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_BUFFER_SIZE = 10;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MESSAGE_SIZE = 256 * 1024; // 256KB max message size

/** Send a JSON message to a WebSocket, silently ignoring errors (e.g. disconnected). */
function trySendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Peer already disconnected
  }
}

export class ChannelRoom extends DurableObject<{ RELAY_SECRET: string }> {
  private session: SessionState | null = null;
  private pluginWs: WebSocket | null = null;
  private appWs: WebSocket | null = null;

  /**
   * In-memory only message buffer for reconnection.
   * NOT persisted to storage — messages are lost if the DO evicts.
   * This is intentional: we don't store user content on disk.
   */
  private volatileBuffer: BufferedMessage[] = [];

  constructor(ctx: DurableObjectState, env: { RELAY_SECRET: string }) {
    super(ctx, env);

    // Restore WebSocket references after hibernation.
    // The runtime keeps the connections alive but our in-memory
    // references (pluginWs, appWs) are lost when the DO is evicted.
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes("plugin")) {
        this.pluginWs = ws;
      } else if (tags.includes("app")) {
        this.appWs = ws;
      }
    }
  }

  /** Lazy-load session from storage on first access */
  private async ensureSession(): Promise<void> {
    if (this.session) return;
    const saved = await this.ctx.storage.get<SessionState>("session");
    if (saved) {
      this.session = saved;
    }
  }

  private getSession(): SessionState {
    if (!this.session) {
      throw new Error("Session not initialized");
    }
    return this.session;
  }

  /**
   * Initialize a new pairing session. Called from POST /pair.
   */
  async initSession(pluginSessionId: string): Promise<{ code: string; sessionToken: string }> {
    const code = generatePairingCode();
    const sessionToken = await generateSessionToken(this.env.RELAY_SECRET, pluginSessionId);

    this.session = {
      pairingCode: code,
      pairingExpiresAt: Date.now() + PAIRING_CODE_TTL_MS,
      pluginSessionId,
      appSessionId: null,
      paired: false,
      lastActivity: Date.now(),
    };

    // Persist and schedule cleanup
    await this.ctx.storage.put("session", this.session);
    await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);

    return { code, sessionToken };
  }

  /**
   * HTTP fetch handler — used for the pairing code lookup.
   */
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      console.error(
        `[ChannelRoom] fetch: ${request.method} ${url.pathname}${url.search} | upgrade=${request.headers.get("upgrade")} | session=${!!this.session}`,
      );
      return await this._fetch(request);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : "";
      console.error(`[ChannelRoom] Error: ${msg}\n${stack}`);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  private async _fetch(request: Request): Promise<Response> {
    await this.ensureSession();
    const url = new URL(request.url);

    // ── Pairing registry endpoints (only for "__pairing_registry__" DO) ──

    if (url.pathname === "/register-code" && request.method === "POST") {
      const { code, sessionId } = await request.json<{ code: string; sessionId: string }>();
      // Persist to DO storage so it survives eviction
      await this.ctx.storage.put(`code:${code}`, {
        sessionId,
        expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
      } satisfies CodeEntry);
      return Response.json({ ok: true });
    }

    if (url.pathname === "/lookup-code" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) return Response.json({ error: "Missing code" }, { status: 400 });

      const entry = await this.ctx.storage.get<CodeEntry>(`code:${code}`);
      if (!entry) return Response.json({ error: "Unknown code" }, { status: 404 });
      if (Date.now() > entry.expiresAt) {
        await this.ctx.storage.delete(`code:${code}`);
        return Response.json({ error: "Code expired" }, { status: 410 });
      }

      // Delete code after successful lookup (one-time use)
      await this.ctx.storage.delete(`code:${code}`);
      return Response.json({ sessionId: entry.sessionId });
    }

    // ── Session endpoints ──

    // POST /revoke — kill this session, close all connections
    if (url.pathname === "/revoke" && request.method === "POST") {
      // Close all WebSockets
      if (this.pluginWs) {
        try {
          this.pluginWs.close(1000, "Session revoked");
        } catch {
          /* already closed */
        }
        this.pluginWs = null;
      }
      if (this.appWs) {
        try {
          this.appWs.close(1000, "Session revoked");
        } catch {
          /* already closed */
        }
        this.appWs = null;
      }

      // Clear all state
      this.session = null;
      this.volatileBuffer = [];
      await this.ctx.storage.deleteAll();

      return Response.json({ ok: true, message: "Session revoked" });
    }

    // POST /init — initialize session (called internally by worker)
    if (url.pathname === "/init" && request.method === "POST") {
      const { pluginSessionId } = await request.json<{ pluginSessionId: string }>();
      const result = await this.initSession(pluginSessionId);
      return Response.json(result);
    }

    // WebSocket upgrade — the worker forwards the original request, so
    // we see the public URL paths (/ws/plugin, /ws/app) and their params.
    // Also support /ws?role=... for local dev / tests.
    if (url.pathname === "/ws/plugin" || url.pathname === "/ws/app" || url.pathname === "/ws") {
      // Determine role from path or query param
      let role: WebSocketRole | null = null;
      if (url.pathname === "/ws/plugin") role = "plugin";
      else if (url.pathname === "/ws/app") role = "app";
      else role = url.searchParams.get("role") as WebSocketRole | null;

      const token = url.searchParams.get("session") ?? url.searchParams.get("token");
      const code = url.searchParams.get("code");

      // Legacy: token/code in URL (still supported for backwards compat)
      if (role === "plugin" && token) {
        return this.handlePluginConnect(token);
      }
      if (role === "app" && code) {
        return this.handleAppConnectWithCode(code);
      }
      if (role === "app" && token) {
        return this.handleAppReconnect(token);
      }

      // New: no token in URL — accept connection, authenticate on first message.
      // Tag as "pending-<role>" until authenticated.
      if (role === "plugin" || role === "app") {
        return this.handlePendingConnect(role);
      }

      return Response.json({ error: "Invalid parameters" }, { status: 400 });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  /**
   * Plugin connects with its session token.
   */
  private async handlePluginConnect(token: string): Promise<Response> {
    if (!this.session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const valid = await validateSessionToken(
      this.env.RELAY_SECRET,
      this.session.pluginSessionId,
      token,
    );
    if (!valid) {
      return Response.json({ error: "Invalid token" }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["plugin"]);
    this.pluginWs = server;

    // Notify plugin of current state
    server.send(
      JSON.stringify({
        type: this.session.paired ? "partner_connected" : "waiting_for_pair",
        timestamp: new Date().toISOString(),
      }),
    );

    if (this.session.paired && this.appWs) {
      trySendJson(this.appWs, { type: "partner_connected", timestamp: new Date().toISOString() });
    }

    // Deliver buffered messages sent while plugin was disconnected
    this.deliverBufferedMessages(server, "app");

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * App connects with a pairing code (first time).
   */
  private async handleAppConnectWithCode(code: string): Promise<Response> {
    if (!this.session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    // Check pairing code
    if (!this.session.pairingCode || this.session.pairingCode !== code) {
      return Response.json({ error: "Invalid pairing code" }, { status: 403 });
    }

    // Check expiry
    if (this.session.pairingExpiresAt && Date.now() > this.session.pairingExpiresAt) {
      return Response.json({ error: "Pairing code expired" }, { status: 410 });
    }

    // Generate app session
    const appSessionId = crypto.randomUUID();
    const appToken = await generateSessionToken(this.env.RELAY_SECRET, appSessionId);

    this.session.appSessionId = appSessionId;
    this.session.paired = true;
    this.session.pairingCode = null;
    this.session.pairingExpiresAt = null;
    this.session.lastActivity = Date.now();

    // Persist updated session
    await this.ctx.storage.put("session", this.session);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["app"]);
    this.appWs = server;

    // Send pairing confirmation with app's session token and session ID
    // (session ID needed for reconnection — the outer worker uses it to find this DO)
    server.send(
      JSON.stringify({
        type: "paired",
        sessionToken: appToken,
        sessionId: this.session.pluginSessionId,
        timestamp: new Date().toISOString(),
      }),
    );

    if (this.pluginWs) {
      trySendJson(this.pluginWs, { type: "paired", timestamp: new Date().toISOString() });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * App reconnects with its session token.
   */
  private async handleAppReconnect(token: string): Promise<Response> {
    if (!this.session || !this.session.appSessionId) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const valid = await validateSessionToken(
      this.env.RELAY_SECRET,
      this.session.appSessionId,
      token,
    );
    if (!valid) {
      return Response.json({ error: "Invalid token" }, { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["app"]);
    this.appWs = server;

    // Send reconnection confirmation
    server.send(
      JSON.stringify({
        type: "reconnected",
        partnerConnected: this.pluginWs !== null,
        timestamp: new Date().toISOString(),
      }),
    );

    if (this.pluginWs) {
      trySendJson(this.pluginWs, {
        type: "partner_connected",
        timestamp: new Date().toISOString(),
      });
    }

    // Deliver buffered messages sent while app was disconnected
    this.deliverBufferedMessages(server, "plugin");

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Accept a WebSocket connection without authentication.
   * The client must send { type: "auth", token: "...", id?: "..." } or
   * { type: "auth", code: "..." } as the first message.
   * Tagged as "pending" until authenticated.
   */
  private handlePendingConnect(role: WebSocketRole): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag as pending — will be re-tagged after auth
    this.ctx.acceptWebSocket(server, [`pending-${role}`]);

    // Send a prompt to authenticate
    server.send(
      JSON.stringify({
        type: "auth_required",
        timestamp: new Date().toISOString(),
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle the first message from a pending (unauthenticated) connection.
   * Expects: { type: "auth", token: "...", id?: "..." } or { type: "auth", code: "..." }
   */
  private async handleAuthMessage(ws: WebSocket, tags: string[], data: string): Promise<void> {
    let parsed: { type?: string; token?: string; code?: string; id?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      trySendJson(ws, { type: "error", message: "Invalid JSON" });
      ws.close(4000, "Invalid auth message");
      return;
    }

    if (parsed.type !== "auth") {
      trySendJson(ws, {
        type: "error",
        message: "First message must be { type: 'auth', ... }",
      });
      ws.close(4001, "Auth required");
      return;
    }

    const isPendingPlugin = tags.includes("pending-plugin");

    if (isPendingPlugin && parsed.token) {
      // Plugin auth with token
      if (!this.session) {
        trySendJson(ws, { type: "error", message: "Session not found" });
        ws.close(4002, "No session");
        return;
      }
      const valid = await validateSessionToken(
        this.env.RELAY_SECRET,
        this.session.pluginSessionId,
        parsed.token,
      );
      if (!valid) {
        trySendJson(ws, { type: "error", message: "Invalid token" });
        ws.close(4003, "Auth failed");
        return;
      }

      // Authenticated — promote to full plugin connection
      // Note: Hibernation API doesn't support changing tags, so we track via the WS ref
      this.pluginWs = ws;

      trySendJson(ws, {
        type: this.session.paired ? "partner_connected" : "waiting_for_pair",
        timestamp: new Date().toISOString(),
      });

      if (this.session.paired && this.appWs) {
        trySendJson(this.appWs, {
          type: "partner_connected",
          timestamp: new Date().toISOString(),
        });
      }

      this.deliverBufferedMessages(ws, "app");
      return;
    }

    if (!isPendingPlugin && parsed.code) {
      // App auth with pairing code
      if (!this.session) {
        trySendJson(ws, { type: "error", message: "Session not found" });
        ws.close(4002, "No session");
        return;
      }
      if (!this.session.pairingCode || this.session.pairingCode !== parsed.code) {
        trySendJson(ws, { type: "error", message: "Invalid pairing code" });
        ws.close(4003, "Auth failed");
        return;
      }
      if (this.session.pairingExpiresAt && Date.now() > this.session.pairingExpiresAt) {
        trySendJson(ws, { type: "error", message: "Code expired" });
        ws.close(4004, "Code expired");
        return;
      }

      // Generate app session
      const appSessionId = crypto.randomUUID();
      const appToken = await generateSessionToken(this.env.RELAY_SECRET, appSessionId);

      this.session.appSessionId = appSessionId;
      this.session.paired = true;
      this.session.pairingCode = null;
      this.session.pairingExpiresAt = null;
      this.session.lastActivity = Date.now();
      await this.ctx.storage.put("session", this.session);

      this.appWs = ws;

      trySendJson(ws, {
        type: "paired",
        sessionToken: appToken,
        sessionId: this.session.pluginSessionId,
        timestamp: new Date().toISOString(),
      });

      if (this.pluginWs) {
        trySendJson(this.pluginWs, {
          type: "paired",
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (!isPendingPlugin && parsed.token) {
      // App reconnect with token
      if (!this.session || !this.session.appSessionId) {
        trySendJson(ws, { type: "error", message: "Session not found" });
        ws.close(4002, "No session");
        return;
      }
      const valid = await validateSessionToken(
        this.env.RELAY_SECRET,
        this.session.appSessionId,
        parsed.token,
      );
      if (!valid) {
        trySendJson(ws, { type: "error", message: "Invalid token" });
        ws.close(4003, "Auth failed");
        return;
      }

      this.appWs = ws;

      trySendJson(ws, {
        type: "reconnected",
        partnerConnected: this.pluginWs !== null,
        timestamp: new Date().toISOString(),
      });

      if (this.pluginWs) {
        trySendJson(this.pluginWs, {
          type: "partner_connected",
          timestamp: new Date().toISOString(),
        });
      }

      this.deliverBufferedMessages(ws, "plugin");
      return;
    }

    trySendJson(ws, { type: "error", message: "Missing token or code" });
    ws.close(4001, "Auth required");
  }

  /**
   * Deliver buffered messages from a specific sender to the reconnected side.
   */
  private deliverBufferedMessages(ws: WebSocket, fromRole: WebSocketRole): void {
    const toDeliver = this.volatileBuffer.filter((m) => m.from === fromRole);
    for (const msg of toDeliver) {
      try {
        ws.send(msg.data);
      } catch {
        break;
      }
    }
    this.volatileBuffer = this.volatileBuffer.filter((m) => m.from !== fromRole);
  }

  /**
   * Buffer a message for reconnection delivery.
   */
  private bufferMessage(from: WebSocketRole, data: string): void {
    this.volatileBuffer.push({ from, data, timestamp: Date.now() });
    if (this.volatileBuffer.length > MESSAGE_BUFFER_SIZE) {
      this.volatileBuffer.shift();
    }
    // Intentionally NOT persisted to storage — user content stays in memory only
  }

  /**
   * WebSocket message handler (called by Durable Object runtime).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ensureSession();

    const data = typeof message === "string" ? message : new TextDecoder().decode(message);

    // Enforce message size limit
    if (data.length > MAX_MESSAGE_SIZE) {
      trySendJson(ws, {
        type: "error",
        message: "Message too large (max 256KB)",
      });
      return;
    }

    const tags = this.ctx.getTags(ws);

    // ── Handle pending (unauthenticated) connections ──
    if (tags.includes("pending-plugin") || tags.includes("pending-app")) {
      await this.handleAuthMessage(ws, tags, data);
      return;
    }

    if (!this.session) return;

    // Determine role — check tags first, then fall back to WS reference
    // (pending-* tagged connections get promoted via handleAuthMessage
    // but tags can't be changed in the Hibernation API)
    let role: WebSocketRole;
    if (tags.includes("plugin")) {
      role = "plugin";
    } else if (tags.includes("app")) {
      role = "app";
    } else if (ws === this.pluginWs) {
      role = "plugin";
    } else if (ws === this.appWs) {
      role = "app";
    } else {
      // Unknown WS — shouldn't happen, but don't crash
      return;
    }

    this.session.lastActivity = Date.now();

    // Reset inactivity alarm
    await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);

    // Parse for ping/pong handling
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
        return;
      }
    } catch {
      // Not JSON, forward as-is
    }

    // Forward to the other side
    const target = role === "plugin" ? this.appWs : this.pluginWs;
    if (target) {
      try {
        target.send(data);
      } catch {
        // Target disconnected, buffer it
        this.bufferMessage(role, data);
      }
    } else {
      // Other side not connected, buffer it
      this.bufferMessage(role, data);
    }
  }

  /**
   * WebSocket close handler.
   */
  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const tags = this.ctx.getTags(ws);
    // Determine role (same logic as webSocketMessage — tags or WS ref)
    let role: WebSocketRole;
    if (tags.includes("plugin")) role = "plugin";
    else if (tags.includes("app")) role = "app";
    else if (ws === this.pluginWs) role = "plugin";
    else if (ws === this.appWs) role = "app";
    else return; // Pending connection that never authenticated — just drop it
    const partner = role === "plugin" ? this.appWs : this.pluginWs;

    if (role === "plugin") {
      this.pluginWs = null;
    } else {
      this.appWs = null;
    }

    if (partner) {
      trySendJson(partner, {
        type: "partner_disconnected",
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * WebSocket error handler.
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1006, "error", false);
  }

  /**
   * Alarm handler — cleanup inactive sessions.
   */
  async alarm(): Promise<void> {
    if (!this.session) return;

    // If no activity for the timeout period, clean up
    if (Date.now() - this.session.lastActivity > INACTIVITY_TIMEOUT_MS) {
      // Close any remaining connections
      if (this.pluginWs) {
        try {
          this.pluginWs.close(1000, "Session expired");
        } catch {
          // Already closed
        }
      }
      if (this.appWs) {
        try {
          this.appWs.close(1000, "Session expired");
        } catch {
          // Already closed
        }
      }
      this.session = null;
      await this.ctx.storage.deleteAll();
    }
  }
}
