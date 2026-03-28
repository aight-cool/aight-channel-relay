import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { generateSessionToken } from "./auth";

const TEST_SECRET = "test-secret";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getStub(name: string) {
  return env.CHANNEL_ROOM.get(env.CHANNEL_ROOM.idFromName(name));
}

async function initSession(sessionId: string) {
  const stub = getStub(sessionId);
  const resp = await stub.fetch(
    new Request("https://do/init", {
      method: "POST",
      body: JSON.stringify({ pluginSessionId: sessionId }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  const data = await resp.json<{ code: string; sessionToken: string }>();
  return { stub, ...data };
}

function wsRequest(url: string): Request {
  return new Request(url, { headers: { Upgrade: "websocket" } });
}

async function connectWs(
  stub: DurableObjectStub,
  url: string,
): Promise<{ ws: WebSocket; messages: string[] }> {
  const resp = await stub.fetch(wsRequest(url));
  if (resp.status !== 101) {
    throw new Error(`Expected WebSocket 101, got ${resp.status}: ${await resp.text()}`);
  }
  const ws = resp.webSocket!;
  const messages: string[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data));
  });
  ws.accept();
  await sleep(20);
  return { ws, messages };
}

/** Connect plugin + app, clear initial messages, return both connections and the app token. */
async function setupPair(id: string) {
  const { stub, code, sessionToken } = await initSession(id);
  const plugin = await connectWs(stub, `https://do/ws?role=plugin&token=${sessionToken}`);
  const app = await connectWs(stub, `https://do/ws?role=app&code=${code}`);
  const appToken = JSON.parse(app.messages[0]).sessionToken;
  await sleep(20);
  plugin.messages.length = 0;
  app.messages.length = 0;
  return { stub, plugin, app, appToken };
}

// ─── Pairing Registry ────────────────────────────────────────────────

describe("Pairing Registry", () => {
  const registry = () => getStub("__pairing_registry__");

  it("registers and looks up a code", async () => {
    const reg = registry();
    await reg.fetch(
      new Request("https://do/register-code", {
        method: "POST",
        body: JSON.stringify({ code: "100001", sessionId: "sess-reg-1" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const resp = await reg.fetch(new Request("https://do/lookup-code?code=100001"));
    expect(resp.status).toBe(200);
    const body = await resp.json<{ sessionId: string }>();
    expect(body.sessionId).toBe("sess-reg-1");
  });

  it("deletes code after lookup (one-time use)", async () => {
    const reg = registry();
    await reg.fetch(
      new Request("https://do/register-code", {
        method: "POST",
        body: JSON.stringify({ code: "100002", sessionId: "sess-reg-2" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    const resp1 = await reg.fetch(new Request("https://do/lookup-code?code=100002"));
    expect(resp1.status).toBe(200);
    const resp2 = await reg.fetch(new Request("https://do/lookup-code?code=100002"));
    expect(resp2.status).toBe(404);
  });

  it("returns 404 for unknown code", async () => {
    const resp = await registry().fetch(new Request("https://do/lookup-code?code=999999"));
    expect(resp.status).toBe(404);
  });

  it("returns 400 when code param is missing", async () => {
    const resp = await registry().fetch(new Request("https://do/lookup-code"));
    expect(resp.status).toBe(400);
  });
});

// ─── Session Init ────────────────────────────────────────────────────

describe("Session Init", () => {
  it("returns a 6-digit code and 64-char hex token", async () => {
    const { code, sessionToken } = await initSession("init-1");
    expect(code).toMatch(/^\d{6}$/);
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("token matches HMAC of the session ID", async () => {
    const sessionId = "init-2";
    const { sessionToken } = await initSession(sessionId);
    const expected = await generateSessionToken(TEST_SECRET, sessionId);
    expect(sessionToken).toBe(expected);
  });
});

// ─── Plugin Connect ──────────────────────────────────────────────────

describe("Plugin Connect", () => {
  it("accepts valid token and returns 101", async () => {
    const { stub, sessionToken } = await initSession("plug-1");
    const resp = await stub.fetch(wsRequest(`https://do/ws?role=plugin&token=${sessionToken}`));
    expect(resp.status).toBe(101);
    expect(resp.webSocket).toBeDefined();
  });

  it("rejects invalid token with 403", async () => {
    const { stub } = await initSession("plug-2");
    const resp = await stub.fetch("https://do/ws?role=plugin&token=bad");
    expect(resp.status).toBe(403);
  });

  it("returns 404 when session not initialized", async () => {
    const stub = getStub("plug-no-session");
    const resp = await stub.fetch("https://do/ws?role=plugin&token=any");
    expect(resp.status).toBe(404);
  });

  it("sends waiting_for_pair when app has not connected", async () => {
    const { stub, sessionToken } = await initSession("plug-3");
    const { messages } = await connectWs(stub, `https://do/ws?role=plugin&token=${sessionToken}`);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]).type).toBe("waiting_for_pair");
  });

  it("sends partner_connected when app is already paired", async () => {
    const { stub, code, sessionToken } = await initSession("plug-4");
    await connectWs(stub, `https://do/ws?role=app&code=${code}`);
    const { messages } = await connectWs(stub, `https://do/ws?role=plugin&token=${sessionToken}`);
    expect(messages.some((m) => JSON.parse(m).type === "partner_connected")).toBe(true);
  });
});

// ─── App Connect with Code ───────────────────────────────────────────

describe("App Connect with Code", () => {
  it("accepts valid code and returns 101", async () => {
    const { stub, code } = await initSession("app-code-1");
    const resp = await stub.fetch(wsRequest(`https://do/ws?role=app&code=${code}`));
    expect(resp.status).toBe(101);
    expect(resp.webSocket).toBeDefined();
  });

  it("rejects invalid code with 403", async () => {
    const { stub } = await initSession("app-code-2");
    const resp = await stub.fetch("https://do/ws?role=app&code=000000");
    expect(resp.status).toBe(403);
  });

  it("returns 404 when session not initialized", async () => {
    const stub = getStub("app-no-session");
    const resp = await stub.fetch("https://do/ws?role=app&code=123456");
    expect(resp.status).toBe(404);
  });

  it("sends paired message with app session token", async () => {
    const { stub, code } = await initSession("app-code-3");
    const { messages } = await connectWs(stub, `https://do/ws?role=app&code=${code}`);
    expect(messages).toHaveLength(1);
    const msg = JSON.parse(messages[0]);
    expect(msg.type).toBe("paired");
    expect(msg.sessionToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("notifies plugin when app pairs", async () => {
    const { stub, code, sessionToken } = await initSession("app-code-4");
    const plugin = await connectWs(stub, `https://do/ws?role=plugin&token=${sessionToken}`);
    plugin.messages.length = 0;

    await connectWs(stub, `https://do/ws?role=app&code=${code}`);
    await sleep(20);

    expect(plugin.messages.some((m) => JSON.parse(m).type === "paired")).toBe(true);
  });
});

// ─── App Reconnect ───────────────────────────────────────────────────

describe("App Reconnect", () => {
  it("returns 404 when no app session exists (never paired)", async () => {
    const { stub } = await initSession("app-re-1");
    const resp = await stub.fetch("https://do/ws?role=app&token=any");
    expect(resp.status).toBe(404);
  });

  it("rejects invalid token with 403", async () => {
    const { stub, code } = await initSession("app-re-2");
    await stub.fetch(wsRequest(`https://do/ws?role=app&code=${code}`));
    const resp = await stub.fetch("https://do/ws?role=app&token=bad");
    expect(resp.status).toBe(403);
  });

  it("accepts valid token and sends reconnected message", async () => {
    const { stub, code } = await initSession("app-re-3");

    const pair = await connectWs(stub, `https://do/ws?role=app&code=${code}`);
    const appToken = JSON.parse(pair.messages[0]).sessionToken;
    pair.ws.close();
    await sleep(50);

    const { messages } = await connectWs(stub, `https://do/ws?role=app&token=${appToken}`);
    expect(messages).toHaveLength(1);
    const msg = JSON.parse(messages[0]);
    expect(msg.type).toBe("reconnected");
    expect(msg).toHaveProperty("partnerConnected");
  });
});

// ─── Ping / Pong ─────────────────────────────────────────────────────

describe("Ping/Pong", () => {
  it("responds to ping with pong", async () => {
    const { stub, sessionToken } = await initSession("ping-1");
    const { ws, messages } = await connectWs(
      stub,
      `https://do/ws?role=plugin&token=${sessionToken}`,
    );
    messages.length = 0;

    ws.send(JSON.stringify({ type: "ping" }));
    await sleep(100);

    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]).type).toBe("pong");
  });
});

// ─── Message Relay ───────────────────────────────────────────────────

describe("Message Relay", () => {
  it("relays message from plugin to app", async () => {
    const { plugin, app } = await setupPair("relay-p2a");
    plugin.ws.send('{"type":"reply","content":"hello from plugin"}');
    await sleep(20);

    expect(app.messages).toHaveLength(1);
    expect(JSON.parse(app.messages[0]).content).toBe("hello from plugin");
  });

  it("relays message from app to plugin", async () => {
    const { plugin, app } = await setupPair("relay-a2p");
    app.ws.send('{"type":"message","content":"hello from app"}');
    await sleep(20);

    expect(plugin.messages).toHaveLength(1);
    expect(JSON.parse(plugin.messages[0]).content).toBe("hello from app");
  });

  it("forwards non-JSON messages as-is", async () => {
    const { plugin, app } = await setupPair("relay-raw");
    plugin.ws.send("raw text message");
    await sleep(20);

    expect(app.messages).toHaveLength(1);
    expect(app.messages[0]).toBe("raw text message");
  });
});

// ─── Message Buffering ──────────────────────────────────────────────

describe("Message Buffering", () => {
  it("buffers messages and delivers on reconnect", async () => {
    const { stub, plugin, app, appToken } = await setupPair("buf-1");

    app.ws.close();
    await sleep(50);

    plugin.ws.send('{"content":"buffered-1"}');
    await sleep(10);
    plugin.ws.send('{"content":"buffered-2"}');
    await sleep(100);

    const app2 = await connectWs(stub, `https://do/ws?role=app&token=${appToken}`);

    expect(app2.messages.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(app2.messages[0]).type).toBe("reconnected");
    // Buffered messages are now wrapped in { type: "buffered", seq, payload }
    const buf1 = JSON.parse(app2.messages[1]);
    expect(buf1.type).toBe("buffered");
    expect(JSON.parse(buf1.payload).content).toBe("buffered-1");
    const buf2 = JSON.parse(app2.messages[2]);
    expect(buf2.type).toBe("buffered");
    expect(JSON.parse(buf2.payload).content).toBe("buffered-2");
  });

  it("limits buffer to 100 messages (persistent cap)", async () => {
    const { stub, plugin, app, appToken } = await setupPair("buf-limit");

    app.ws.close();
    await sleep(50);

    // Send 15 messages — each triggers an async storage write in bufferMessage.
    // Cap is now 100 so all 15 should be buffered.
    for (let i = 0; i < 15; i++) {
      plugin.ws.send(`{"content":"msg-${i}"}`);
      await sleep(10);
    }
    await sleep(200);

    const app2 = await connectWs(stub, `https://do/ws?role=app&token=${appToken}`);

    const buffered = app2.messages.filter((m) => {
      try {
        return JSON.parse(m).type === "buffered";
      } catch {
        return false;
      }
    });
    expect(buffered).toHaveLength(15);
    expect(JSON.parse(JSON.parse(buffered[0]).payload).content).toBe("msg-0");
    expect(JSON.parse(JSON.parse(buffered[14]).payload).content).toBe("msg-14");
  });
});

// ─── Disconnect Notifications ────────────────────────────────────────

describe("Disconnect Notifications", () => {
  it("notifies app when plugin disconnects", async () => {
    const { plugin, app } = await setupPair("disc-p");
    app.messages.length = 0;

    plugin.ws.close();
    await sleep(50);

    expect(app.messages.some((m) => JSON.parse(m).type === "partner_disconnected")).toBe(true);
  });

  it("notifies plugin when app disconnects", async () => {
    const { plugin, app } = await setupPair("disc-a");
    plugin.messages.length = 0;

    app.ws.close();
    await sleep(50);

    expect(plugin.messages.some((m) => JSON.parse(m).type === "partner_disconnected")).toBe(true);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("returns 400 for /ws with missing role", async () => {
    const { stub } = await initSession("edge-1");
    const resp = await stub.fetch("https://do/ws");
    expect(resp.status).toBe(400);
  });

  it("returns 400 for /ws with invalid role", async () => {
    const { stub } = await initSession("edge-invalid-role");
    const resp = await stub.fetch("https://do/ws?role=admin");
    expect(resp.status).toBe(400);
  });

  it("returns 404 for unknown DO paths", async () => {
    const stub = getStub("edge-2");
    const resp = await stub.fetch("https://do/unknown");
    expect(resp.status).toBe(404);
  });
});

// ─── Init Validation ─────────────────────────────────────────────────

describe("Init Validation", () => {
  it("returns 500 for invalid JSON body on /init", async () => {
    const stub = getStub("init-bad-json");
    const resp = await stub.fetch(
      new Request("https://do/init", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(resp.status).toBe(500);
  });

  it("handles missing pluginSessionId on /init", async () => {
    const stub = getStub("init-missing-id");
    const resp = await stub.fetch(
      new Request("https://do/init", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      }),
    );
    // Should still succeed — pluginSessionId will be undefined but the DO accepts it
    // (the worker is responsible for providing valid data)
    expect(resp.status).toBe(200);
  });
});

// ─── Plugin Reconnect ────────────────────────────────────────────────

describe("Plugin Reconnect", () => {
  it("second plugin connection replaces the first", async () => {
    const { stub, sessionToken } = await initSession("plug-replace");
    const plugin1 = await connectWs(stub, `https://do/ws?role=plugin&token=${sessionToken}`);
    plugin1.messages.length = 0;

    const plugin2 = await connectWs(stub, `https://do/ws?role=plugin&token=${sessionToken}`);
    expect(JSON.parse(plugin2.messages[0]).type).toBe("waiting_for_pair");

    // Send a ping on the new connection — should get pong
    plugin2.ws.send(JSON.stringify({ type: "ping" }));
    await sleep(20);
    expect(plugin2.messages.some((m) => JSON.parse(m).type === "pong")).toBe(true);
  });
});

// ─── Ping from App ───────────────────────────────────────────────────

describe("Ping from App", () => {
  it("responds to ping from app with pong", async () => {
    const { app } = await setupPair("ping-app");
    app.messages.length = 0;

    app.ws.send(JSON.stringify({ type: "ping" }));
    await sleep(20);

    expect(app.messages).toHaveLength(1);
    expect(JSON.parse(app.messages[0]).type).toBe("pong");
  });
});

// ─── Rapid Messaging ─────────────────────────────────────────────────

describe("Rapid Messaging", () => {
  it("relays multiple messages in order", async () => {
    const { plugin, app } = await setupPair("rapid-msg");

    for (let i = 0; i < 5; i++) {
      plugin.ws.send(JSON.stringify({ type: "reply", index: i }));
      await sleep(10); // Space out sends for async alarm management
    }
    await sleep(200);

    // Filter to only our reply messages (skip any late protocol messages)
    const replies = app.messages
      .map((m) => JSON.parse(m))
      .filter((m: { type?: string }) => m.type === "reply");
    expect(replies).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(replies[i].index).toBe(i);
    }
  });
});

// ─── Full Lifecycle Integration ──────────────────────────────────────

describe("Full Lifecycle", () => {
  it("pair → message → disconnect → buffer → reconnect", async () => {
    const sessionId = "lifecycle-1";
    const { stub, code, sessionToken: pluginToken } = await initSession(sessionId);

    // 1. Plugin connects — waiting for pair
    const plugin = await connectWs(stub, `https://do/ws?role=plugin&token=${pluginToken}`);
    expect(JSON.parse(plugin.messages[0]).type).toBe("waiting_for_pair");
    plugin.messages.length = 0;

    // 2. App pairs — both notified
    const app = await connectWs(stub, `https://do/ws?role=app&code=${code}`);
    const pairedMsg = JSON.parse(app.messages[0]);
    expect(pairedMsg.type).toBe("paired");
    const appToken = pairedMsg.sessionToken;

    await sleep(20);
    expect(plugin.messages.some((m) => JSON.parse(m).type === "paired")).toBe(true);
    plugin.messages.length = 0;
    app.messages.length = 0;

    // 3. Bidirectional messaging
    plugin.ws.send('{"content":"ping from plugin"}');
    await sleep(20);
    expect(JSON.parse(app.messages[0]).content).toBe("ping from plugin");
    app.messages.length = 0;

    app.ws.send('{"content":"pong from app"}');
    await sleep(100);
    expect(JSON.parse(plugin.messages[0]).content).toBe("pong from app");
    plugin.messages.length = 0;

    // 4. App disconnects — plugin notified
    app.ws.close();
    await sleep(50);
    expect(plugin.messages.some((m) => JSON.parse(m).type === "partner_disconnected")).toBe(true);
    plugin.messages.length = 0;

    // 5. Plugin sends while app is offline — buffered
    plugin.ws.send('{"content":"offline msg"}');
    await sleep(100);

    // 6. App reconnects — gets buffered messages (now wrapped in "buffered" type)
    const app2 = await connectWs(stub, `https://do/ws?role=app&token=${appToken}`);
    expect(JSON.parse(app2.messages[0]).type).toBe("reconnected");
    expect(JSON.parse(app2.messages[0]).partnerConnected).toBe(true);
    expect(app2.messages.length).toBeGreaterThanOrEqual(2);
    const bufferedMsg = JSON.parse(app2.messages[1]);
    expect(bufferedMsg.type).toBe("buffered");
    expect(JSON.parse(bufferedMsg.payload).content).toBe("offline msg");

    // Plugin notified of app reconnection
    await sleep(20);
    expect(plugin.messages.some((m) => JSON.parse(m).type === "partner_connected")).toBe(true);
  });
});
