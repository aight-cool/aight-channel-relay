import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// ─── Health check ────────────────────────────────────────────────────

describe("GET /", () => {
  it("returns health check JSON", async () => {
    const resp = await SELF.fetch("https://relay/");
    expect(resp.status).toBe(200);
    const body = await resp.json<{ ok: boolean; service: string; version: string }>();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("aight-channel-relay");
    expect(body.version).toBeDefined();
  });

  it("includes CORS headers", async () => {
    const resp = await SELF.fetch("https://relay/");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ─── CORS preflight ──────────────────────────────────────────────────

describe("OPTIONS preflight", () => {
  it("returns 204 with CORS headers", async () => {
    const resp = await SELF.fetch("https://relay/pair", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(resp.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });
});

// ─── POST /pair ──────────────────────────────────────────────────────

describe("POST /pair", () => {
  it("returns pairing code, session token, and session ID", async () => {
    const resp = await SELF.fetch("https://relay/pair", { method: "POST" });
    expect(resp.status).toBe(200);

    const body = await resp.json<{ code: string; sessionToken: string; sessionId: string }>();
    expect(body.code).toMatch(/^\d{6}$/);
    expect(body.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique sessions on each call", async () => {
    const r1 = await (
      await SELF.fetch("https://relay/pair", { method: "POST" })
    ).json<{
      sessionId: string;
    }>();
    const r2 = await (
      await SELF.fetch("https://relay/pair", { method: "POST" })
    ).json<{
      sessionId: string;
    }>();
    expect(r1.sessionId).not.toBe(r2.sessionId);
  });
});

// ─── GET /ws/plugin — error cases ────────────────────────────────────

describe("GET /ws/plugin", () => {
  it("returns 400 without session parameter", async () => {
    const resp = await SELF.fetch("https://relay/ws/plugin");
    expect(resp.status).toBe(400);
  });

  it("returns 400 without id parameter", async () => {
    const resp = await SELF.fetch("https://relay/ws/plugin?session=abc");
    expect(resp.status).toBe(400);
  });

  it("returns 403 with invalid token", async () => {
    const resp = await SELF.fetch("https://relay/ws/plugin?session=bad&id=fake-session");
    expect(resp.status).toBe(403);
  });
});

// ─── GET /ws/app — error cases ───────────────────────────────────────

describe("GET /ws/app", () => {
  it("returns 400 without code or session parameter", async () => {
    const resp = await SELF.fetch("https://relay/ws/app");
    expect(resp.status).toBe(400);
  });

  it("returns 400 without id when using session", async () => {
    const resp = await SELF.fetch("https://relay/ws/app?session=abc");
    expect(resp.status).toBe(400);
  });

  it("returns 403 with invalid pairing code", async () => {
    const resp = await SELF.fetch("https://relay/ws/app?code=000000");
    expect(resp.status).toBe(403);
  });
});

// ─── Unknown routes ──────────────────────────────────────────────────

describe("Unknown routes", () => {
  it("returns 404", async () => {
    const resp = await SELF.fetch("https://relay/unknown");
    expect(resp.status).toBe(404);
  });
});
