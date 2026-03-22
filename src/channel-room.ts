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

interface WebSocketAttachment {
  role: WebSocketRole;
  sessionId: string;
}

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_BUFFER_SIZE = 10;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class ChannelRoom implements DurableObject {
  private state: DurableObjectState;
  private env: { RELAY_SECRET: string };
  private session: SessionState | null = null;
  private pluginWs: WebSocket | null = null;
  private appWs: WebSocket | null = null;

  /** Pairing code registry (only used by the "__pairing_registry__" instance) */
  private codeRegistry = new Map<string, CodeEntry>();

  constructor(state: DurableObjectState, env: { RELAY_SECRET: string }) {
    this.state = state;
    this.env = env;
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

    // Schedule cleanup alarm
    await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);

    return { code, sessionToken };
  }

  /**
   * HTTP fetch handler — used for the pairing code lookup.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── Pairing registry endpoints (only for "__pairing_registry__" DO) ──

    if (url.pathname === "/register-code" && request.method === "POST") {
      const { code, sessionId } = await request.json<{ code: string; sessionId: string }>();
      this.codeRegistry.set(code, {
        sessionId,
        expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
      });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/lookup-code" && request.method === "GET") {
      const code = url.searchParams.get("code");
      if (!code) return Response.json({ error: "Missing code" }, { status: 400 });

      const entry = this.codeRegistry.get(code);
      if (!entry) return Response.json({ error: "Unknown code" }, { status: 404 });
      if (Date.now() > entry.expiresAt) {
        this.codeRegistry.delete(code);
        return Response.json({ error: "Code expired" }, { status: 410 });
      }

      // Delete code after successful lookup (one-time use)
      this.codeRegistry.delete(code);
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

    this.state.acceptWebSocket(server, ["plugin"]);
    this.pluginWs = server;

    // Notify plugin of current state
    server.send(
      JSON.stringify({
        type: this.session.paired ? "partner_connected" : "waiting_for_pair",
        timestamp: new Date().toISOString(),
      }),
    );

    // Notify app that plugin reconnected
    if (this.session.paired && this.appWs) {
      try {
        this.appWs.send(
          JSON.stringify({ type: "partner_connected", timestamp: new Date().toISOString() }),
        );
      } catch {
        // App disconnected
      }
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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server, ["app"]);
    this.appWs = server;

    // Send pairing confirmation with app's session token
    server.send(
      JSON.stringify({
        type: "paired",
        sessionToken: appToken,
        timestamp: new Date().toISOString(),
      }),
    );

    // Notify plugin that app paired
    if (this.pluginWs) {
      try {
        this.pluginWs.send(
          JSON.stringify({ type: "paired", timestamp: new Date().toISOString() }),
        );
      } catch {
        // Plugin disconnected
      }
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

    this.state.acceptWebSocket(server, ["app"]);
    this.appWs = server;

    // Send reconnection confirmation
    server.send(
      JSON.stringify({
        type: "reconnected",
        partnerConnected: this.pluginWs !== null,
        timestamp: new Date().toISOString(),
      }),
    );

    // Notify plugin that app reconnected
    if (this.pluginWs) {
      try {
        this.pluginWs.send(
          JSON.stringify({ type: "partner_connected", timestamp: new Date().toISOString() }),
        );
      } catch {
        // Plugin disconnected
      }
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
    const messages = this.session.messageBuffer.filter((m) => m.from === fromRole);
    for (const msg of messages) {
      try {
        ws.send(msg.data);
      } catch {
        break;
      }
    }
  }

  /**
   * Buffer a message for reconnection delivery.
   */
  private bufferMessage(from: WebSocketRole, data: string): void {
    if (!this.session) return;
    this.session.messageBuffer.push({ from, data, timestamp: Date.now() });
    if (this.session.messageBuffer.length > MESSAGE_BUFFER_SIZE) {
      this.session.messageBuffer.shift();
    }
  }

  /**
   * WebSocket message handler (called by Durable Object runtime).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.session) return;

    const data = typeof message === "string" ? message : new TextDecoder().decode(message);
    const tags = this.state.getTags(ws);
    const role = tags.includes("plugin") ? "plugin" : "app";

    this.session.lastActivity = Date.now();

    // Reset inactivity alarm
    await this.state.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);

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
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const tags = this.state.getTags(ws);
    const role = tags.includes("plugin") ? "plugin" : "app";

    if (role === "plugin") {
      this.pluginWs = null;
      // Notify app
      if (this.appWs) {
        try {
          this.appWs.send(
            JSON.stringify({ type: "partner_disconnected", timestamp: new Date().toISOString() }),
          );
        } catch {
          // App also disconnected
        }
      }
    } else {
      this.appWs = null;
      // Notify plugin
      if (this.pluginWs) {
        try {
          this.pluginWs.send(
            JSON.stringify({ type: "partner_disconnected", timestamp: new Date().toISOString() }),
          );
        } catch {
          // Plugin also disconnected
        }
      }
    }
  }

  /**
   * WebSocket error handler.
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    // Treat errors as disconnections
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
    }
  }
}
