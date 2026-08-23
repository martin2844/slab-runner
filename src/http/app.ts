import { timingSafeEqual } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
} from "express";
import { ZodError } from "zod";
import type { RuntimeAdapter } from "../runtime/adapter.js";
import { publicError, RunnerError } from "../runtime/errors.js";
import {
  approvalDecisionSchema,
  parseExecutionRequest,
  type RunnerEvent,
} from "../runtime/protocol.js";
import type { RunManager } from "../runtime/run-manager.js";

function isAuthorized(request: Request, expectedToken: string): boolean {
  const authorization = request.header("authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.header("x-runner-token");
  if (!supplied) return false;
  const actualBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedToken);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function sendEvent(response: Response, event: RunnerEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createHttpApp(options: {
  runManager: RunManager;
  adapters: RuntimeAdapter[];
  runnerToken?: string;
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  if (options.runnerToken) {
    const token = options.runnerToken;
    app.use((request, response, next) => {
      if (isAuthorized(request, token)) next();
      else
        response.status(401).json({
          error: {
            code: "INVALID_REQUEST",
            message: "Authentication required",
          },
        });
    });
  }

  app.get("/runtimes", async (_request, response, next) => {
    try {
      const data = await Promise.all(
        options.adapters.map(async (adapter) => {
          try {
            return await adapter.health();
          } catch {
            return { id: adapter.id, available: false };
          }
        }),
      );
      response.json({ data });
    } catch (error) {
      next(error);
    }
  });

  app.post("/runs", (request, response, next) => {
    try {
      const result = options.runManager.create(
        parseExecutionRequest(request.body),
      );
      response.status(202).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/runs/:runId/attach", (request, response, next) => {
    try {
      const runId = request.params.runId;
      if (!runId)
        throw new RunnerError("RUN_NOT_FOUND", "Run was not found", 404);
      const status = options.runManager.status(runId);
      if (status) {
        response.json({ runId, status });
        return;
      }
      if (options.runManager.wasSeen(runId)) {
        throw new RunnerError(
          "RUN_HISTORY_EXPIRED",
          "Run history is no longer available",
          410,
        );
      }
      throw new RunnerError("RUN_NOT_FOUND", "Run was not found", 404);
    } catch (error) {
      next(error);
    }
  });

  app.get("/runs/:runId/events", (request, response, next) => {
    try {
      const runId = request.params.runId;
      if (!runId)
        throw new RunnerError("RUN_NOT_FOUND", "Run was not found", 404);
      if (!options.runManager.has(runId)) {
        throw new RunnerError("RUN_NOT_FOUND", "Run was not found", 404);
      }
      const lastEventId = Number.parseInt(
        request.header("last-event-id") ?? "0",
        10,
      );
      const afterEventId = Number.isFinite(lastEventId) ? lastEventId : 0;
      response.status(200);
      response.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();

      let closed = false;
      let keepAlive: NodeJS.Timeout | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        response.end();
      };
      const snapshot = options.runManager.openEventStream(
        runId,
        afterEventId,
        (event) => {
          sendEvent(response, event);
          if (event.type.startsWith("run.") && event.type !== "run.started")
            close();
        },
      );
      for (const event of snapshot.events) sendEvent(response, event);
      if (snapshot.terminal) close();
      else {
        keepAlive = setInterval(
          () => response.write(": keepalive\n\n"),
          15_000,
        );
        keepAlive.unref();
      }
      request.on("close", () => {
        snapshot.unsubscribe();
        if (keepAlive) clearInterval(keepAlive);
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/runs/:runId", async (request, response, next) => {
    try {
      const runId = request.params.runId;
      if (!runId)
        throw new RunnerError("RUN_NOT_FOUND", "Run was not found", 404);
      response.json(await options.runManager.cancel(runId));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/runs/:runId/approvals/:approvalId",
    async (request, response, next) => {
      try {
        const runId = request.params.runId;
        const approvalId = request.params.approvalId;
        if (!runId || !approvalId) {
          throw new RunnerError(
            "APPROVAL_FAILED",
            "Pending approval was not found",
            404,
          );
        }
        const { decision } = approvalDecisionSchema.parse(request.body);
        response.json(
          await options.runManager.respondToApproval(
            runId,
            approvalId,
            decision,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((_request, response) => {
    response.status(404).json({
      error: { code: "INVALID_REQUEST", message: "Endpoint was not found" },
    });
  });

  const errorHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    next,
  ) => {
    void next;
    if (response.headersSent) {
      response.end();
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({
        error: {
          code: "INVALID_REQUEST",
          message: "Request body must be valid JSON",
        },
      });
      return;
    }
    const normalized =
      error instanceof RunnerError
        ? error
        : new RunnerError(
            "UNKNOWN_RUNTIME_ERROR",
            "The request could not be completed",
            500,
          );
    response
      .status(normalized.httpStatus)
      .json({ error: publicError(normalized) });
  };
  app.use(errorHandler);
  return app;
}

export type HttpApp = ReturnType<typeof createHttpApp>;
