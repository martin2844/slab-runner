import type {
  AppServerConnection,
  RpcNotification,
} from "../app-server/connection.js";
import {
  type ActivityLease,
  RuntimeActivityGate,
} from "../runtime/activity-gate.js";
import { RunnerError } from "../runtime/errors.js";

type CodexLoginStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";
type MutationKind = "start" | "cancel" | "logout";

export interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
  status: CodexLoginStatus;
  expiresAt: string;
}

export interface CodexAuthStatus {
  status: "authenticated" | "not_authenticated" | "unavailable";
  authMode: "chatgpt" | "api_key" | "cloud_provider" | "unknown" | null;
  email: string | null;
  planType: string | null;
  login: CodexDeviceLogin | null;
}

interface ActiveLogin extends CodexDeviceLogin {
  expiresAtMs: number;
}

interface DeviceLoginResult {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

const DEFAULT_LOGIN_TTL_MS = 15 * 60 * 1_000;
const DEFAULT_READ_TIMEOUT_MS = 5_000;
const DEFAULT_MUTATION_RESPONSE_TIMEOUT_MS = 10_000;
const TERMINAL_LOGIN_RETENTION_MS = 5 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function publicAuthMode(
  account: Record<string, unknown>,
): CodexAuthStatus["authMode"] {
  switch (account.type) {
    case "chatgpt":
    case "chatgptAuthTokens":
      return "chatgpt";
    case "apiKey":
      return "api_key";
    case "amazonBedrock":
      return "cloud_provider";
    default:
      return "unknown";
  }
}

function invalidAuthResponse(): RunnerError {
  return new RunnerError(
    "UNKNOWN_RUNTIME_ERROR",
    "Codex returned an invalid authentication response",
    502,
  );
}

function parseDeviceLoginResult(value: unknown): DeviceLoginResult {
  if (!isRecord(value)) throw invalidAuthResponse();
  const { type, loginId, verificationUrl, userCode } = value;
  if (
    type !== "chatgptDeviceCode" ||
    typeof loginId !== "string" ||
    loginId.length === 0 ||
    loginId.length > 256 ||
    typeof verificationUrl !== "string" ||
    typeof userCode !== "string" ||
    userCode.length === 0 ||
    userCode.length > 64 ||
    [...userCode].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw invalidAuthResponse();
  }
  let url: URL;
  try {
    url = new URL(verificationUrl);
  } catch {
    throw invalidAuthResponse();
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "openai.com" && !url.hostname.endsWith(".openai.com"))
  ) {
    throw invalidAuthResponse();
  }
  return { type, loginId, verificationUrl: url.toString(), userCode };
}

export class CodexAuthManager {
  #login: ActiveLogin | null = null;
  #authLease: ActivityLease | null = null;
  #mutationKind: MutationKind | null = null;
  #startPromise: Promise<CodexDeviceLogin> | null = null;
  #cancelPromise: Promise<CodexDeviceLogin> | null = null;
  #logoutPromise: Promise<CodexAuthStatus> | null = null;

  constructor(
    private readonly connection: AppServerConnection,
    private readonly activityGate = new RuntimeActivityGate(),
    private readonly now: () => number = Date.now,
    private readonly loginTtlMs = DEFAULT_LOGIN_TTL_MS,
    private readonly readTimeoutMs = DEFAULT_READ_TIMEOUT_MS,
    private readonly mutationResponseTimeoutMs =
      DEFAULT_MUTATION_RESPONSE_TIMEOUT_MS,
  ) {
    connection.on("notification", (notification) => {
      this.handleNotification(notification);
    });
    connection.on("crash", () => {
      if (
        this.#login?.status === "pending" ||
        this.#login?.status === "expired"
      ) {
        this.#login.status = "failed";
      }
      this.#authLease?.release();
      this.#authLease = null;
    });
  }

  async status(): Promise<CodexAuthStatus> {
    this.refreshLoginState();
    if (!this.connection.ready) return this.unavailableStatus();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.readTimeoutMs);
    timeout.unref();
    try {
      const result = await this.connection.request(
        "account/read",
        { refreshToken: false },
        { signal: controller.signal },
      );
      if (
        !isRecord(result) ||
        !Object.prototype.hasOwnProperty.call(result, "account")
      ) {
        return this.unavailableStatus();
      }
      const account = result.account;
      if (account === null) {
        return {
          status: "not_authenticated",
          authMode: null,
          email: null,
          planType: null,
          login: this.publicLogin(),
        };
      }
      if (!isRecord(account)) return this.unavailableStatus();
      return {
        status: "authenticated",
        authMode: publicAuthMode(account),
        email: optionalString(account.email),
        planType: optionalString(account.planType),
        login: this.publicLogin(),
      };
    } catch {
      return this.unavailableStatus();
    } finally {
      clearTimeout(timeout);
    }
  }

  startDeviceLogin(): Promise<CodexDeviceLogin> {
    this.refreshLoginState();
    if (this.#login?.status === "pending") {
      return Promise.resolve(this.publicLoginRequired());
    }
    if (this.#startPromise) {
      return this.withMutationResponseDeadline(this.#startPromise);
    }
    this.assertNoConflictingMutation("start");
    const operation = this.startDeviceLoginOnce().then(
      (login) => {
        this.#startPromise = null;
        return login;
      },
      (error: unknown) => {
        this.#startPromise = null;
        throw error;
      },
    );
    this.#startPromise = operation;
    return this.withMutationResponseDeadline(operation);
  }

  cancelDeviceLogin(loginId: string): Promise<CodexDeviceLogin> {
    this.refreshLoginState();
    if (
      !this.#login ||
      this.#login.loginId !== loginId ||
      (this.#login.status !== "pending" && this.#login.status !== "expired")
    ) {
      return Promise.reject(
        new RunnerError(
          "INVALID_REQUEST",
          "Pending Codex authentication was not found",
          404,
        ),
      );
    }
    if (this.#cancelPromise) {
      return this.withMutationResponseDeadline(this.#cancelPromise);
    }
    this.assertNoConflictingMutation("cancel");
    const operation = this.cancelDeviceLoginOnce(loginId).then(
      (login) => {
        this.#cancelPromise = null;
        return login;
      },
      (error: unknown) => {
        this.#cancelPromise = null;
        throw error;
      },
    );
    this.#cancelPromise = operation;
    return this.withMutationResponseDeadline(operation);
  }

  logout(): Promise<CodexAuthStatus> {
    if (this.#logoutPromise) {
      return this.withMutationResponseDeadline(this.#logoutPromise);
    }
    this.assertNoConflictingMutation("logout");
    const operation = this.logoutOnce().then(
      (status) => {
        this.#logoutPromise = null;
        return status;
      },
      (error: unknown) => {
        this.#logoutPromise = null;
        throw error;
      },
    );
    this.#logoutPromise = operation;
    return this.withMutationResponseDeadline(operation);
  }

  private async startDeviceLoginOnce(): Promise<CodexDeviceLogin> {
    this.#mutationKind = "start";
    try {
      this.ensureAuthLease();
      if (this.#login?.status === "expired") {
        const expiredLogin = this.#login;
        await this.connection.request("account/login/cancel", {
          loginId: expiredLogin.loginId,
        });
        if (
          this.#login === expiredLogin &&
          (expiredLogin.status === "pending" ||
            expiredLogin.status === "expired")
        ) {
          expiredLogin.status = "cancelled";
        }
        if (this.#login === expiredLogin && expiredLogin.status === "succeeded") {
          return this.publicLoginRequired();
        }
      }
      const result = parseDeviceLoginResult(
        await this.connection.request("account/login/start", {
          type: "chatgptDeviceCode",
        }),
      );
      const expiresAtMs = this.now() + this.loginTtlMs;
      this.#login = {
        loginId: result.loginId,
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        status: "pending",
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
      };
      return this.publicLoginRequired();
    } finally {
      this.#mutationKind = null;
      this.releaseAuthLeaseIfIdle();
    }
  }

  private async cancelDeviceLoginOnce(
    loginId: string,
  ): Promise<CodexDeviceLogin> {
    this.#mutationKind = "cancel";
    const login = this.#login;
    try {
      this.ensureAuthLease();
      await this.connection.request("account/login/cancel", { loginId });
      if (
        this.#login === login &&
        (login?.status === "pending" || login?.status === "expired")
      ) {
        login.status = "cancelled";
      }
      return this.publicLoginRequired();
    } finally {
      this.#mutationKind = null;
      this.releaseAuthLeaseIfIdle();
    }
  }

  private async logoutOnce(): Promise<CodexAuthStatus> {
    this.#mutationKind = "logout";
    try {
      this.ensureAuthLease();
      const login = this.#login;
      if (login?.status === "pending" || login?.status === "expired") {
        await this.connection.request("account/login/cancel", {
          loginId: login.loginId,
        });
        if (
          this.#login === login &&
          (login.status === "pending" || login.status === "expired")
        ) {
          login.status = "cancelled";
        }
      }
      await this.connection.request("account/logout", {});
      this.#login = null;
    } finally {
      this.#mutationKind = null;
      this.releaseAuthLeaseIfIdle();
    }
    return this.status();
  }

  private assertNoConflictingMutation(requested: MutationKind): void {
    if (this.#mutationKind && this.#mutationKind !== requested) {
      throw new RunnerError(
        "INVALID_REQUEST",
        "Another Codex authentication change is already in progress",
        409,
      );
    }
  }

  private ensureAuthLease(): void {
    if (!this.connection.ready) {
      throw new RunnerError(
        "RUNTIME_UNAVAILABLE",
        "Codex runtime is unavailable",
        503,
      );
    }
    this.#authLease ??= this.activityGate.beginAuthMutation();
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method !== "account/login/completed" || !this.#login) {
      return;
    }
    const params = notification.params;
    if (!params || params.loginId !== this.#login.loginId) return;
    if (this.#login.status !== "pending" && this.#login.status !== "expired") {
      return;
    }
    this.#login.status = params.success === true ? "succeeded" : "failed";
    this.releaseAuthLeaseIfIdle();
  }

  private refreshLoginState(): void {
    if (!this.#login) return;
    const age = this.now() - this.#login.expiresAtMs;
    if (this.#login.status === "pending" && age >= 0) {
      this.#login.status = "expired";
    } else if (
      this.#login.status !== "pending" &&
      this.#login.status !== "expired" &&
      age >= TERMINAL_LOGIN_RETENTION_MS
    ) {
      this.#login = null;
    }
  }

  private releaseAuthLeaseIfIdle(): void {
    if (
      this.#mutationKind ||
      this.#login?.status === "pending" ||
      this.#login?.status === "expired"
    ) {
      return;
    }
    this.#authLease?.release();
    this.#authLease = null;
  }

  private withMutationResponseDeadline<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new RunnerError(
            "RUNTIME_UNAVAILABLE",
            "Codex authentication is still waiting for the runtime",
            503,
          ),
        );
      }, this.mutationResponseTimeoutMs);
      timeout.unref();
      operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error("Request failed"));
        },
      );
    });
  }

  private unavailableStatus(): CodexAuthStatus {
    return {
      status: "unavailable",
      authMode: null,
      email: null,
      planType: null,
      login: this.publicLogin(),
    };
  }

  private publicLogin(): CodexDeviceLogin | null {
    if (!this.#login) return null;
    const { expiresAtMs: _, ...login } = this.#login;
    void _;
    return login;
  }

  private publicLoginRequired(): CodexDeviceLogin {
    const login = this.publicLogin();
    if (!login) throw new Error("Codex login state is unavailable.");
    return login;
  }
}
