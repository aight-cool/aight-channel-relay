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
  /** Last 10 messages for reconnection buffer */
  messageBuffer: BufferedMessage[];
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

  constructor(ctx: DurableObjectState, env: { RELAY_SECRET: string }) {
    super(ctx, env);

    // Restore session from storage if DO was evicted and re-instantiated
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get<SessionState>("session");
      if (saved) {
        this.session = saved;
      }
    });
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
      messageBuffer: [],
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
      console.log(
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

    // POST /init — initialize session (called internally by worker)
    if (url.pathname === "/init" && request.method === "POST") {
      const { pluginSessionId } = await request.json<{ pluginSessionId: string }>();
      const result = await this.initSession(pluginSessionId);
      return Response.json(result);
    }

    // GET /ws — WebSocket upgrade
    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") as WebSocketRole | null;
      const token = url.searchParams.get("token");
      const code = url.searchParams.get("code");

      if (role === "plugin" && token) {
        return this.handlePluginConnect(token);
      }
      if (role === "app" && code) {
        return this.handleAppConnectWithCode(code);
      }
      if (role === "app" && token) {
        return this.handleAppReconnect(token);
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
   * Deliver buffered messages from a specific sender to the reconnected side.
   */
  private deliverBufferedMessages(ws: WebSocket, fromRole: WebSocketRole): void {
    if (!this.session) return;
    const toDeliver = this.session.messageBuffer.filter((m) => m.from === fromRole);
    for (const msg of toDeliver) {
      try {
        ws.send(msg.data);
      } catch {
        break;
      }
    }
    // Remove delivered messages from buffer
    this.session.messageBuffer = this.session.messageBuffer.filter((m) => m.from !== fromRole);
  }

  /**
   * Buffer a message for reconnection delivery.
   */
  private async bufferMessage(from: WebSocketRole, data: string): Promise<void> {
    if (!this.session) return;
    this.session.messageBuffer.push({ from, data, timestamp: Date.now() });
    if (this.session.messageBuffer.length > MESSAGE_BUFFER_SIZE) {
      this.session.messageBuffer.shift();
    }
    await this.ctx.storage.put("session", this.session);
  }

  /**
   * WebSocket message handler (called by Durable Object runtime).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.session) return;

    const data = typeof message === "string" ? message : new TextDecoder().decode(message);
    const tags = this.ctx.getTags(ws);
    const role = tags.includes("plugin") ? "plugin" : "app";

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
    const role = tags.includes("plugin") ? "plugin" : "app";
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
