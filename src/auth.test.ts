import { describe, it, expect } from "vitest";
import {
  generateSessionToken,
  validateSessionToken,
  generatePairingCode,
  generateSessionId,
} from "./auth";

// ─── generateSessionToken ────────────────────────────────────────────

describe("generateSessionToken", () => {
  it("produces a 64-character hex string (SHA-256)", async () => {
    const token = await generateSessionToken("secret", "session-1");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", async () => {
    const a = await generateSessionToken("secret", "session-1");
    const b = await generateSessionToken("secret", "session-1");
    expect(a).toBe(b);
  });

  it("differs for different session IDs", async () => {
    const a = await generateSessionToken("secret", "session-1");
    const b = await generateSessionToken("secret", "session-2");
    expect(a).not.toBe(b);
  });

  it("differs for different secrets", async () => {
    const a = await generateSessionToken("secret-a", "session-1");
    const b = await generateSessionToken("secret-b", "session-1");
    expect(a).not.toBe(b);
  });
});

// ─── validateSessionToken ────────────────────────────────────────────

describe("validateSessionToken", () => {
  it("returns true for a valid token", async () => {
    const token = await generateSessionToken("secret", "session-1");
    expect(await validateSessionToken("secret", "session-1", token)).toBe(true);
  });

  it("returns false for an invalid token", async () => {
    expect(await validateSessionToken("secret", "session-1", "bad")).toBe(false);
  });

  it("returns false for wrong session ID", async () => {
    const token = await generateSessionToken("secret", "session-1");
    expect(await validateSessionToken("secret", "session-2", token)).toBe(false);
  });

  it("returns false for wrong secret", async () => {
    const token = await generateSessionToken("secret-a", "session-1");
    expect(await validateSessionToken("secret-b", "session-1", token)).toBe(false);
  });

  it("returns false for empty token", async () => {
    expect(await validateSessionToken("secret", "session-1", "")).toBe(false);
  });
});

// ─── generatePairingCode ─────────────────────────────────────────────

describe("generatePairingCode", () => {
  it("produces a 6-digit numeric string", () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("always pads to 6 characters", () => {
    for (let i = 0; i < 100; i++) {
      expect(generatePairingCode()).toHaveLength(6);
    }
  });
});

// ─── generateSessionId ──────────────────────────────────────────────

describe("generateSessionId", () => {
  it("produces a 32-character lowercase hex string", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSessionId()));
    expect(ids.size).toBe(50);
  });
});
