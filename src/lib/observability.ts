import type { Redactor } from "./redactor.js";

const PREVIEW_LIMIT = 500;

export type PayloadMeasurement = {
  bytes: number;
  approxTokens: number;
  preview: string;
};

export type SearchToolResultSummary = {
  query: string;
  resultCount: number;
  results: Array<{
    id: string | null;
    slug: string | null;
    title: string;
    score: number | null;
  }>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseToolPayload(value: unknown): unknown {
  const response = record(value);
  if (response.structuredContent) return response.structuredContent;
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content
    .map(record)
    .find((item) => item.type === "text" && typeof item.text === "string")
    ?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function summarizeSearchTool(
  tool: string,
  argumentsValue: unknown,
  responseValue: unknown,
): SearchToolResultSummary | null {
  if (!tool.startsWith("search_")) return null;
  const argumentsRecord = record(argumentsValue);
  const queryValue = argumentsRecord.query ?? argumentsRecord.q;
  if (typeof queryValue !== "string" || !queryValue.trim()) return null;

  const payload = record(parseToolPayload(responseValue));
  const rawResults = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.results)
      ? payload.results
      : [];
  const results = rawResults.map(record).map((result) => ({
    id: typeof result.id === "string" ? result.id : null,
    slug: typeof result.slug === "string" ? result.slug : null,
    title:
      typeof result.title === "string"
        ? result.title
        : typeof result.key === "string"
          ? result.key
          : "Untitled result",
    score:
      typeof result.score === "number" && Number.isFinite(result.score)
        ? result.score
        : null,
  }));
  return {
    query: queryValue,
    resultCount: results.length,
    results,
  };
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

export function approxTokens(characters: number): number {
  return characters === 0 ? 0 : Math.ceil(characters / 4);
}

export function measurePayload(
  value: unknown,
  redactor: Redactor,
  previewLimit = PREVIEW_LIMIT,
): PayloadMeasurement {
  const serialized = serialize(value);
  const safeSerialized = serialize(redactor.value(value));
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    approxTokens: approxTokens(serialized.length),
    preview:
      safeSerialized.length > previewLimit
        ? `${safeSerialized.slice(0, previewLimit)}…`
        : safeSerialized,
  };
}

export function measureText(
  value: string,
  redactor: Redactor,
  previewLimit = PREVIEW_LIMIT,
): PayloadMeasurement {
  const safeValue = redactor.text(value);
  return {
    bytes: Buffer.byteLength(value, "utf8"),
    approxTokens: approxTokens(value.length),
    preview:
      safeValue.length > previewLimit
        ? `${safeValue.slice(0, previewLimit)}…`
        : safeValue,
  };
}
