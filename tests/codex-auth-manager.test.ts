import { describe, expect, it } from "vitest";
import { CodexAuthManager } from "../src/auth/codex-auth-manager.js";
import { RuntimeActivityGate } from "../src/runtime/activity-gate.js";
import { FakeAppServerConnection } from "./helpers/fake-connection.js";

const deviceLogin = {
  type: "chatgptDeviceCode",
  loginId: "login-1",
  verificationUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-1234",
};

describe("CodexAuthManager", () => {
  it("reports only the public account fields", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method) => {
      expect(method).toBe("account/read");
      return Promise.resolve({
        account: {
          type: "chatgpt",
          email: "operator@example.com",
          planType: "plus",
          accessToken: "must-not-leave-runner",
        },
        requiresOpenaiAuth: true,
      });
    };
    const manager = new CodexAuthManager(connection);

    await expect(manager.status()).resolves.toEqual({
      status: "authenticated",
      authMode: "chatgpt",
      email: "operator@example.com",
      planType: "plus",
      login: null,
    });
  });

  it("starts one idempotent device login and tracks completion notifications", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method, params) => {
      expect(method).toBe("account/login/start");
      expect(params).toEqual({ type: "chatgptDeviceCode" });
      return Promise.resolve(deviceLogin);
    };
    const manager = new CodexAuthManager(
      connection,
      new RuntimeActivityGate(),
      () => Date.parse("2026-08-27T12:00:00.000Z"),
    );

    const expected = {
      loginId: "login-1",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      status: "pending",
      expiresAt: "2026-08-27T12:15:00.000Z",
    };
    await expect(manager.startDeviceLogin()).resolves.toEqual(expected);
    await expect(manager.startDeviceLogin()).resolves.toEqual(expected);
    expect(connection.requests).toHaveLength(1);

    connection.serverNotification({
      method: "account/login/completed",
      params: { loginId: "different-login", success: true, error: null },
    });
    await expect(manager.startDeviceLogin()).resolves.toMatchObject({
      status: "pending",
    });
    connection.serverNotification({
      method: "account/login/completed",
      params: { loginId: "login-1", success: true, error: null },
    });
    connection.requestHandler = () => Promise.resolve({
      account: { type: "chatgpt", email: null, planType: "pro" },
    });
    await expect(manager.status()).resolves.toMatchObject({
      status: "authenticated",
      login: { loginId: "login-1", status: "succeeded" },
    });
  });

  it("cancels only the current pending device login", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method, params) => {
      if (method === "account/login/start") return Promise.resolve(deviceLogin);
      expect(method).toBe("account/login/cancel");
      expect(params).toEqual({ loginId: "login-1" });
      return Promise.resolve({});
    };
    const manager = new CodexAuthManager(connection);
    await manager.startDeviceLogin();

    await expect(manager.cancelDeviceLogin("not-current")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      httpStatus: 404,
    });
    await expect(manager.cancelDeviceLogin("login-1")).resolves.toMatchObject({
      loginId: "login-1",
      status: "cancelled",
    });
  });

  it("blocks login and logout while a Codex run is active", async () => {
    const connection = new FakeAppServerConnection();
    const gate = new RuntimeActivityGate();
    const runLease = gate.beginRun();
    const manager = new CodexAuthManager(connection, gate);

    await expect(manager.startDeviceLogin()).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      httpStatus: 409,
    });
    await expect(manager.logout()).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      httpStatus: 409,
    });
    expect(connection.requests).toEqual([]);
    runLease.release();
  });

  it("rejects a device login URL outside the OpenAI authentication boundary", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = () =>
      Promise.resolve({
        ...deviceLogin,
        verificationUrl: "https://openai.example.test/phishing",
      });
    const manager = new CodexAuthManager(connection);

    await expect(manager.startDeviceLogin()).rejects.toMatchObject({
      code: "UNKNOWN_RUNTIME_ERROR",
      httpStatus: 502,
      message: "Codex returned an invalid authentication response",
    });
  });

  it("expires device login state without exposing a runtime error", async () => {
    let now = Date.parse("2026-08-27T12:00:00.000Z");
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method) =>
      Promise.resolve(
        method === "account/login/start" ? deviceLogin : { account: null },
      );
    const manager = new CodexAuthManager(
      connection,
      new RuntimeActivityGate(),
      () => now,
    );
    await manager.startDeviceLogin();
    now += 15 * 60 * 1_000;

    await expect(manager.status()).resolves.toMatchObject({
      status: "not_authenticated",
      login: { loginId: "login-1", status: "expired" },
    });
  });

  it("shares an in-flight login start and blocks runs until completion", async () => {
    const connection = new FakeAppServerConnection();
    let resolveStart!: (value: typeof deviceLogin) => void;
    connection.requestHandler = () =>
      new Promise((resolve) => {
        resolveStart = resolve;
      });
    const gate = new RuntimeActivityGate();
    const manager = new CodexAuthManager(connection, gate);

    const first = manager.startDeviceLogin();
    const second = manager.startDeviceLogin();
    expect(connection.requests).toHaveLength(1);
    expect(() => gate.beginRun()).toThrow("Runtime authentication is changing");
    resolveStart(deviceLogin);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ loginId: "login-1" }),
      expect.objectContaining({ loginId: "login-1" }),
    ]);
    expect(() => gate.beginRun()).toThrow("Runtime authentication is changing");

    connection.serverNotification({
      method: "account/login/completed",
      params: { loginId: "login-1", success: true, error: null },
    });
    const runLease = gate.beginRun();
    runLease.release();
  });

  it("treats malformed account responses as unavailable", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = () => Promise.resolve({ account: "invalid" });
    const manager = new CodexAuthManager(connection);

    await expect(manager.status()).resolves.toMatchObject({
      status: "unavailable",
      authMode: null,
    });
    connection.requestHandler = () => Promise.resolve({});
    await expect(manager.status()).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("bounds status reads and keeps an indeterminate mutation gated", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = () => new Promise(() => undefined);
    const gate = new RuntimeActivityGate();
    const manager = new CodexAuthManager(
      connection,
      gate,
      Date.now,
      15 * 60 * 1_000,
      5,
      5,
    );

    await expect(manager.status()).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(manager.startDeviceLogin()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
      httpStatus: 503,
    });
    expect(() => gate.beginRun()).toThrow("Runtime authentication is changing");
    connection.crash();
    const runLease = gate.beginRun();
    runLease.release();
  });

  it("cancels a pending login before logout", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method) => {
      if (method === "account/login/start") return Promise.resolve(deviceLogin);
      if (method === "account/read") return Promise.resolve({ account: null });
      return Promise.resolve({});
    };
    const manager = new CodexAuthManager(connection);
    await manager.startDeviceLogin();
    await manager.logout();

    expect(connection.requests.map(({ method }) => method)).toEqual([
      "account/login/start",
      "account/login/cancel",
      "account/logout",
      "account/read",
    ]);
  });

  it("keeps a pending login gated when logout cannot cancel it", async () => {
    const connection = new FakeAppServerConnection();
    connection.requestHandler = (method) => {
      if (method === "account/login/start") return Promise.resolve(deviceLogin);
      if (method === "account/login/cancel") {
        return Promise.reject(new Error("cancel failed"));
      }
      return Promise.resolve({});
    };
    const gate = new RuntimeActivityGate();
    const manager = new CodexAuthManager(connection, gate);
    await manager.startDeviceLogin();

    await expect(manager.logout()).rejects.toThrow("cancel failed");
    expect(connection.requests.map(({ method }) => method)).toEqual([
      "account/login/start",
      "account/login/cancel",
    ]);
    expect(() => gate.beginRun()).toThrow("Runtime authentication is changing");
  });
});
