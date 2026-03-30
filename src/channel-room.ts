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
 *
 * Message buffering:
 *   Messages sent while the other side is disconnected are persisted to DO
 *   storage (survives eviction). Up to 100 messages, 24h TTL.
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
  /** Timestamp of last activity */
  lastActivity: number;
}

/** Persisted message in DO storage under "msg:<seq>" keys */
interface BufferedStorageMsg {
  from: WebSocketRole;
  data: string;
  ts: number;
}

/** Push credentials stored under "push" key */
interface PushCredentials {
  pushToken: string;
  sendKey: string;
  platform: string;
  sandbox: boolean;
  channelName?: string;
}

type WebSocketRole = "plugin" | "app";
const VALID_ROLES = new Set<string>(["plugin", "app"]);

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MESSAGE_BUFFER_CAP = 100;
const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ALARM_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB max message size (CF DO WebSocket limit)
const PUSH_DEBOUNCE_MS = 30_000;
const PUSH_SERVICE_URL = "https://push.aight.cool/send";

/** Extract sequence number from a "msg:<seq>" storage key. */
function parseSeqFromKey(key: string): number {
  return parseInt(key.split(":")[1]);
}

/** Sort comparator for [key, msg] entries by sequence number. */
function compareBySeq(a: [string, BufferedStorageMsg], b: [string, BufferedStorageMsg]): number {
  return parseSeqFromKey(a[0]) - parseSeqFromKey(b[0]);
}

/** Send a JSON message to a WebSocket, silently ignoring errors (e.g. disconnected). */
function trySendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Peer already disconnected
  }
}

/** Close a WebSocket gracefully, ignoring errors if already closed. */
function tryClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed
  }
}

export class ChannelRoom extends DurableObject<{ RELAY_SECRET: string }> {
  private session: SessionState | null = null;
  private pluginWs: WebSocket | null = null;
  private appWs: WebSocket | null = null;

  /** Volatile — fine to re-push after DO eviction */
  private lastPushAt = 0;

  /** Last time lastActivity was persisted to storage (in-memory) */
  private lastPersistedActivity: number | null = null;
  /** Memory cache for hasBufferedMessages — avoids 2 storage reads per message */
  private cachedHasBuffered: boolean | null = null;

  /**
   * Self-heal: scan live WebSockets for a role whose ref is null or stale.
   * Returns the recovered WS (and updates the ref) or null if none found.
   */
  private healRoleRef(role: WebSocketRole): WebSocket | null {
    const tagMatches = role === "plugin" ? ["plugin", "pending-plugin"] : ["app", "pending-app"];
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tagMatches.some((t) => tags.includes(t))) {
        if (role === "plugin") this.pluginWs = ws;
        else this.appWs = ws;
        return ws;
      }
    }
    return null;
  }

  /** Replace a role's WebSocket, closing the stale one if it differs. */
  private setRoleWs(role: WebSocketRole, ws: WebSocket): void {
    const prev = role === "plugin" ? this.pluginWs : this.appWs;
    if (prev && prev !== ws) tryClose(prev, 4010, "Replaced by new connection");
    if (role === "plugin") this.pluginWs = ws;
    else this.appWs = ws;
  }

  constructor(ctx: DurableObjectState, env: { RELAY_SECRET: string }) {
    super(ctx, env);

    // Restore WebSocket references after hibernation.
    // The runtime keeps the connections alive but our in-memory
    // references (pluginWs, appWs) are lost when the DO is evicted.
    // Multiple WSes per role can exist (stale connections from reconnects).
    // Keep only the last one per role and close the rest.
    const pluginWss: WebSocket[] = [];
    const appWss: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      if (tags.includes("plugin") || tags.includes("pending-plugin")) {
        pluginWss.push(ws);
      } else if (tags.includes("app") || tags.includes("pending-app")) {
        appWss.push(ws);
      }
    }
    if (pluginWss.length > 0) {
      this.pluginWs = pluginWss[pluginWss.length - 1];
      for (let i = 0; i < pluginWss.length - 1; i++) {
        tryClose(pluginWss[i], 4010, "Stale connection after hibernation");
      }
    }
    if (appWss.length > 0) {
      this.appWs = appWss[appWss.length - 1];
      for (let i = 0; i < appWss.length - 1; i++) {
        tryClose(appWss[i], 4010, "Stale connection after hibernation");
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

  // ── Persistent Message Buffer ───────────────────────────────────────────────

  /**
   * Buffer a message to DO storage for reconnection delivery.
   */
  private async bufferMessage(from: WebSocketRole, data: string): Promise<void> {
    const seq = ((await this.ctx.storage.get<number>("msgSeq")) ?? 0) + 1;
    const countKey = `msgCount:${from}`;
    const count = ((await this.ctx.storage.get<number>(countKey)) ?? 0) + 1;

    await this.ctx.storage.put({
      [`msg:${seq}`]: { from, data, ts: Date.now() } satisfies BufferedStorageMsg,
      msgSeq: seq,
      [countKey]: count,
    });

    this.cachedHasBuffered = true;

    // Only check eviction when approaching cap
    if (count >= MESSAGE_BUFFER_CAP) {
      await this.evictIfOverCap();
    }
  }

  /**
   * Deliver buffered messages from a specific sender to the reconnected side.
   * Optionally filter to only messages after a given seq (for catch_up).
   */
  private async deliverBufferedMessages(
    ws: WebSocket,
    fromRole: WebSocketRole,
    afterSeq = 0,
  ): Promise<void> {
    const seq = (await this.ctx.storage.get<number>("msgSeq")) ?? 0;
    if (seq === 0) return;

    const entries = await this.ctx.storage.list<BufferedStorageMsg>({ prefix: "msg:" });
    const toDeliver: [string, BufferedStorageMsg][] = [];

    for (const [key, msg] of entries) {
      if (msg.from !== fromRole) continue;
      if (parseSeqFromKey(key) <= afterSeq) continue;
      toDeliver.push([key, msg]);
    }

    toDeliver.sort(compareBySeq);

    const oldestAvailableSeq = toDeliver.length > 0 ? parseSeqFromKey(toDeliver[0][0]) : 0;

    const sentKeys: string[] = [];
    for (let i = 0; i < toDeliver.length; i++) {
      const [key, msg] = toDeliver[i];
      try {
        ws.send(
          JSON.stringify({
            type: "buffered",
            seq: parseSeqFromKey(key),
            payload: msg.data,
            ...(i === 0 ? { oldestAvailableSeq } : {}),
          }),
        );
        sentKeys.push(key);
      } catch {
        break;
      }
    }

    if (sentKeys.length > 0) {
      await this.ctx.storage.delete(sentKeys);
      const remaining = toDeliver.length - sentKeys.length;
      await this.ctx.storage.put(`msgCount:${fromRole}`, remaining);
      this.cachedHasBuffered = null; // Invalidate cache
    }
  }

  private async evictIfOverCap(): Promise<void> {
    const entries = await this.ctx.storage.list<BufferedStorageMsg>({ prefix: "msg:" });
    if (entries.size <= MESSAGE_BUFFER_CAP) return;

    const sorted = [...entries.entries()].sort(compareBySeq);
    const toDelete = sorted.slice(0, sorted.length - MESSAGE_BUFFER_CAP);
    if (toDelete.length === 0) return;

    // Count deleted per role, subtract from current counts
    let pluginDeleted = 0;
    let appDeleted = 0;
    for (const [, msg] of toDelete) {
      if (msg.from === "plugin") pluginDeleted++;
      else appDeleted++;
    }

    const pluginCount =
      ((await this.ctx.storage.get<number>("msgCount:plugin")) ?? 0) - pluginDeleted;
    const appCount = ((await this.ctx.storage.get<number>("msgCount:app")) ?? 0) - appDeleted;

    await this.ctx.storage.delete(toDelete.map(([key]) => key));
    await this.ctx.storage.put({
      "msgCount:plugin": Math.max(0, pluginCount),
      "msgCount:app": Math.max(0, appCount),
    });
  }

  private async pruneExpiredMessages(olderThan: number): Promise<void> {
    const entries = await this.ctx.storage.list<BufferedStorageMsg>({ prefix: "msg:" });
    const toDeleteSet = new Set<string>();

    for (const [key, msg] of entries) {
      if (msg.ts < olderThan) {
        toDeleteSet.add(key);
      }
    }

    if (toDeleteSet.size > 0) {
      await this.ctx.storage.delete([...toDeleteSet]);

      let pluginCount = 0;
      let appCount = 0;
      for (const [key, msg] of entries) {
        if (!toDeleteSet.has(key)) {
          if (msg.from === "plugin") pluginCount++;
          else appCount++;
        }
      }
      await this.ctx.storage.put({
        "msgCount:plugin": pluginCount,
        "msgCount:app": appCount,
      });
      this.cachedHasBuffered = pluginCount + appCount > 0;
    }
  }

  private async hasBufferedMessages(): Promise<boolean> {
    if (this.cachedHasBuffered !== null) return this.cachedHasBuffered;
    const pluginCount = (await this.ctx.storage.get<number>("msgCount:plugin")) ?? 0;
    const appCount = (await this.ctx.storage.get<number>("msgCount:app")) ?? 0;
    this.cachedHasBuffered = pluginCount + appCount > 0;
    return this.cachedHasBuffered;
  }

  /**
   * Get buffered messages for an HTTP catch-up request (read-only, no delete).
   */
  async getBufferedMessages(
    token: string,
    afterSeq: number,
  ): Promise<{
    messages: Array<{ seq: number; data: string; ts: number }>;
    latestSeq: number;
    oldestAvailableSeq: number;
  } | null> {
    await this.ensureSession();
    if (!this.session || !this.session.appSessionId) return null;

    const valid = await validateSessionToken(
      this.env.RELAY_SECRET,
      this.session.appSessionId,
      token,
    );
    if (!valid) return null;

    const latestSeq = (await this.ctx.storage.get<number>("msgSeq")) ?? 0;
    const entries = await this.ctx.storage.list<BufferedStorageMsg>({ prefix: "msg:" });

    const messages: Array<{ seq: number; data: string; ts: number }> = [];
    let oldestAvailableSeq = 0;

    const sorted = [...entries.entries()]
      .filter(([, msg]) => msg.from === "plugin")
      .sort(compareBySeq);

    for (const [key, msg] of sorted) {
      const seq = parseSeqFromKey(key);
      if (oldestAvailableSeq === 0) oldestAvailableSeq = seq;
      if (seq > afterSeq) {
        messages.push({ seq, data: msg.data, ts: msg.ts });
      }
    }

    return { messages, latestSeq, oldestAvailableSeq };
  }

  // ── Push Notifications ──────────────────────────────────────────────────────

  /**
   * Maybe send a push notification for a buffered message.
   * Debounced to avoid spamming the user.
   */
  private async maybeSendPush(messageData: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastPushAt < PUSH_DEBOUNCE_MS) return;

    const push = await this.ctx.storage.get<PushCredentials>("push");
    if (!push) return;

    // Check if push was invalidated
    const pushInvalid = await this.ctx.storage.get<boolean>("pushInvalid");
    if (pushInvalid) return;

    this.lastPushAt = now;

    // Only push for reply messages (skip tool events, typing, etc.)
    let body: string | null = null;
    try {
      const parsed = JSON.parse(messageData);
      if (parsed.type === "reply" && parsed.content) {
        body = parsed.content.slice(0, 100);
        if (parsed.content.length > 100) body += "\u2026";
      }
    } catch {
      // Not parseable — skip
    }
    if (!body) return;

    // Fire-and-forget — don't block message buffering on push delivery
    this.ctx.waitUntil(
      fetch(PUSH_SERVICE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: push.pushToken,
          sendKey: push.sendKey,
          platform: push.platform,
          sandbox: push.sandbox,
          title: push.channelName || "Claude",
          body,
          data: {
            sessionId: this.session?.pluginSessionId,
            type: "channel_message",
          },
        }),
      })
        .then(async (res) => {
          if (res.status === 403) {
            await this.ctx.storage.put("pushInvalid", true);
          }
        })
        .catch(() => {}),
    );
  }

  // ── Session Init ────────────────────────────────────────────────────────────

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
      lastActivity: Date.now(),
    };

    // Persist and schedule cleanup
    await this.ctx.storage.put("session", this.session);
    await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);

    return { code, sessionToken };
  }

  // ── HTTP Fetch Handler ──────────────────────────────────────────────────────

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
      await this.ctx.storage.deleteAll();

      return Response.json({ ok: true, message: "Session revoked" });
    }

    // POST /init — initialize session (called internally by worker)
    if (url.pathname === "/init" && request.method === "POST") {
      const { pluginSessionId } = await request.json<{ pluginSessionId: string }>();
      const result = await this.initSession(pluginSessionId);
      return Response.json(result);
    }

    // POST /messages — HTTP catch-up endpoint (Phase 2)
    if (url.pathname === "/messages" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return Response.json({ error: "Missing Authorization header" }, { status: 401 });
      }
      const token = authHeader.slice(7);

      let afterSeq = 0;
      try {
        const body = await request.json<{ after?: number }>();
        afterSeq = body.after ?? 0;
      } catch {
        // No body or invalid JSON — default to 0
      }

      const result = await this.getBufferedMessages(token, afterSeq);
      if (!result) {
        return Response.json({ error: "Invalid credentials" }, { status: 403 });
      }

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
      else {
        const roleParam = url.searchParams.get("role");
        role = roleParam && VALID_ROLES.has(roleParam) ? (roleParam as WebSocketRole) : null;
      }

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

  // ── WebSocket Connection Handlers ───────────────────────────────────────────

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
    this.setRoleWs("plugin", server);

    // Notify plugin of current state
    const paired = this.session.appSessionId !== null;
    server.send(
      JSON.stringify({
        type: paired ? "partner_connected" : "waiting_for_pair",
        timestamp: new Date().toISOString(),
      }),
    );

    if (paired && this.appWs) {
      trySendJson(this.appWs, { type: "partner_connected", timestamp: new Date().toISOString() });
    }

    // Deliver buffered messages sent while plugin was disconnected
    await this.deliverBufferedMessages(server, "app");

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
    this.session.pairingCode = null;
    this.session.pairingExpiresAt = null;
    this.session.lastActivity = Date.now();

    // Persist updated session
    await this.ctx.storage.put("session", this.session);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["app"]);
    this.setRoleWs("app", server);

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
    this.setRoleWs("app", server);

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

    // Check if push credentials need re-registration
    const pushInvalid = await this.ctx.storage.get<boolean>("pushInvalid");
    if (pushInvalid) {
      trySendJson(server, { type: "push_reregister", timestamp: new Date().toISOString() });
    }

    // Deliver buffered messages sent while app was disconnected
    await this.deliverBufferedMessages(server, "plugin");

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
      this.setRoleWs("plugin", ws);

      const paired = this.session.appSessionId !== null;
      trySendJson(ws, {
        type: paired ? "partner_connected" : "waiting_for_pair",
        timestamp: new Date().toISOString(),
      });

      if (paired && this.appWs) {
        trySendJson(this.appWs, {
          type: "partner_connected",
          timestamp: new Date().toISOString(),
        });
      }

      await this.deliverBufferedMessages(ws, "app");
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
      this.session.pairingCode = null;
      this.session.pairingExpiresAt = null;
      this.session.lastActivity = Date.now();
      await this.ctx.storage.put("session", this.session);

      this.setRoleWs("app", ws);

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

      this.setRoleWs("app", ws);

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

      // Check if push credentials need re-registration
      const pushInvalid = await this.ctx.storage.get<boolean>("pushInvalid");
      if (pushInvalid) {
        trySendJson(ws, { type: "push_reregister", timestamp: new Date().toISOString() });
      }

      await this.deliverBufferedMessages(ws, "plugin");
      return;
    }

    trySendJson(ws, { type: "error", message: "Missing token or code" });
    ws.close(4001, "Auth required");
  }

  // ── WebSocket Event Handlers ────────────────────────────────────────────────

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
        message: "Message too large (max 1MB)",
      });
      return;
    }

    const tags = this.ctx.getTags(ws);

    // Determine role — check WS refs first (handles pending-* after auth/hibernation),
    // then tags, then treat as pending if truly unauthenticated
    let role: WebSocketRole | null = null;
    if (ws === this.pluginWs) {
      role = "plugin";
    } else if (ws === this.appWs) {
      role = "app";
    } else if (tags.includes("plugin")) {
      role = "plugin";
    } else if (tags.includes("app")) {
      role = "app";
    } else if (tags.includes("pending-plugin") || tags.includes("pending-app")) {
      // Truly unauthenticated — handle auth message
      await this.handleAuthMessage(ws, tags, data);
      return;
    } else {
      return; // Unknown WS
    }

    if (!this.session) return;

    this.session.lastActivity = Date.now();

    // Persist lastActivity every 5 minutes so the alarm doesn't nuke active sessions
    // after DO eviction (lastActivity was only in-memory before this fix)
    const PERSIST_INTERVAL_MS = 5 * 60_000;
    if (this.session.lastActivity - (this.lastPersistedActivity ?? 0) > PERSIST_INTERVAL_MS) {
      this.lastPersistedActivity = this.session.lastActivity;
      this.ctx.waitUntil(this.ctx.storage.put("session", this.session));
    }

    // Parse for protocol-level messages (ping/pong, catch_up, register_push)
    try {
      const parsed = JSON.parse(data);

      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
        return;
      }

      // App-only protocol messages — intercepted, not forwarded
      if (role === "app") {
        if (parsed.type === "catch_up") {
          const afterSeq = typeof parsed.afterSeq === "number" ? parsed.afterSeq : 0;
          await this.deliverBufferedMessages(ws, "plugin", afterSeq);
          // Reset inactivity alarm
          await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
          return;
        }

        if (parsed.type === "register_push") {
          const creds: PushCredentials = {
            pushToken: parsed.pushToken,
            sendKey: parsed.sendKey,
            platform: parsed.platform ?? "ios",
            sandbox: parsed.sandbox ?? false,
            ...(parsed.channelName ? { channelName: parsed.channelName } : {}),
          };
          await this.ctx.storage.put("push", creds);
          // Clear any previous invalid flag since we have fresh credentials
          await this.ctx.storage.delete("pushInvalid");
          // Reset inactivity alarm
          await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
          return;
        }
      }
    } catch {
      // Not JSON, forward as-is
    }

    // Reset inactivity alarm (or extend if buffered messages exist)
    const hasBuffered = await this.hasBufferedMessages();
    if (hasBuffered) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_CHECK_INTERVAL_MS);
    } else {
      await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    // Forward to the other side
    const targetRole: WebSocketRole = role === "plugin" ? "app" : "plugin";
    let target = targetRole === "app" ? this.appWs : this.pluginWs;

    if (target) {
      try {
        target.send(data);
      } catch {
        // Target ref is stale — attempt self-heal before buffering
        target = this.healRoleRef(targetRole);
        if (target) {
          try {
            target.send(data);
          } catch {
            await this.bufferMessage(role, data);
            if (role === "plugin") await this.maybeSendPush(data);
          }
        } else {
          await this.bufferMessage(role, data);
          if (role === "plugin") await this.maybeSendPush(data);
        }
      }
    } else {
      // No ref — attempt self-heal from live WebSockets
      target = this.healRoleRef(targetRole);
      if (target) {
        try {
          target.send(data);
        } catch {
          await this.bufferMessage(role, data);
          if (role === "plugin") await this.maybeSendPush(data);
        }
      } else {
        await this.bufferMessage(role, data);
        if (role === "plugin") await this.maybeSendPush(data);
      }
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
    // Determine role — WS refs first (handles pending-* after auth/hibernation)
    let role: WebSocketRole;
    if (ws === this.pluginWs) role = "plugin";
    else if (ws === this.appWs) role = "app";
    else if (tags.includes("plugin") || tags.includes("pending-plugin")) role = "plugin";
    else if (tags.includes("app") || tags.includes("pending-app")) role = "app";
    else return; // Pending connection that never authenticated — just drop it
    const partner = role === "plugin" ? this.appWs : this.pluginWs;

    // Only nullify the ref if the closing WS is the current one.
    // Stale WebSockets from previous connections must not wipe the active ref.
    if (role === "plugin" && ws === this.pluginWs) {
      this.pluginWs = null;
    } else if (role === "app" && ws === this.appWs) {
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
   * Alarm handler — cleanup inactive sessions, prune expired messages.
   */
  async alarm(): Promise<void> {
    await this.ensureSession();
    if (!this.session) return;

    const now = Date.now();
    const hasBuffered = await this.hasBufferedMessages();

    if (hasBuffered) {
      // Prune messages older than 24h
      await this.pruneExpiredMessages(now - MESSAGE_TTL_MS);

      // If still has messages after prune, reschedule alarm
      if (await this.hasBufferedMessages()) {
        await this.ctx.storage.setAlarm(now + ALARM_CHECK_INTERVAL_MS);
        return;
      }
    }

    // No buffered messages — apply standard inactivity timeout
    if (now - this.session.lastActivity > INACTIVITY_TIMEOUT_MS) {
      // Close any remaining connections
      for (const ws of [this.pluginWs, this.appWs]) {
        try {
          ws?.close(1000, "Session expired");
        } catch {
          /* already closed */
        }
      }
      this.session = null;
      await this.ctx.storage.deleteAll();
    }
  }
}
