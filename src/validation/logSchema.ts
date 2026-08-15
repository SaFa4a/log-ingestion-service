import { z } from "zod";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// Attribute values may be string | number | boolean only. Nested objects
// and arrays are explicitly rejected by the contract.
const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const attributesSchema = z
  .record(z.string(), attributeValueSchema)
  .optional()
  .default({});

// A single log entry, as it must appear inside `logs: [...]`.
// Each `.refine` / custom check below is written to produce one specific,
// human-readable rejection reason — the contract requires we tell the
// caller exactly why an entry was rejected.
const logEntrySchema = z
  .object({
    timestamp: z
      .string({ required_error: "timestamp is required" })
      .refine((v) => !Number.isNaN(Date.parse(v)), {
        message: "invalid timestamp: must be a valid ISO 8601 string",
      }),
    level: z.string({ required_error: "level is required" }),
    service: z
      .string({ required_error: "service is required" })
      .min(1, "service must be a non-empty string"),
    message: z
      .string({ required_error: "message is required" })
      .min(1, "message must be a non-empty string"),
    attributes: attributesSchema,
  })
  .strict();

export interface ValidatedLog {
  timestamp: string; // normalized ISO string
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
}

export interface RejectedLog {
  index: number;
  reason: string;
}

export interface BatchValidationResult {
  accepted: ValidatedLog[];
  rejected: RejectedLog[];
}

/**
 * Validates one raw entry from the batch. Returns either a normalized
 * ValidatedLog or a single human-readable rejection reason — never
 * throws, so a bad entry never aborts the rest of the batch.
 */
function validateEntry(raw: unknown, index: number): ValidatedLog | RejectedLog {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { index, reason: "entry must be a JSON object" };
  }

  const result = logEntrySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    return { index, reason: first?.message ?? "invalid entry" };
  }

  const { timestamp, level, service, message, attributes } = result.data;

  if (!LOG_LEVELS.includes(level as LogLevel)) {
    return { index, reason: `invalid level: '${level}'` };
  }

  const parsedMs = Date.parse(timestamp);
  if (parsedMs > Date.now() + FIVE_MINUTES_MS) {
    return { index, reason: "timestamp must not be more than five minutes in the future" };
  }

  return {
    timestamp: new Date(parsedMs).toISOString(),
    level: level as LogLevel,
    service,
    message,
    attributes,
  };
}

function isRejected(v: ValidatedLog | RejectedLog): v is RejectedLog {
  return "reason" in v;
}

/** Validates an entire ingestion batch, entry by entry. */
export function validateBatch(rawLogs: unknown[]): BatchValidationResult {
  const accepted: ValidatedLog[] = [];
  const rejected: RejectedLog[] = [];

  rawLogs.forEach((raw, index) => {
    const outcome = validateEntry(raw, index);
    if (isRejected(outcome)) {
      rejected.push(outcome);
    } else {
      accepted.push(outcome);
    }
  });

  return { accepted, rejected };
}

// Top-level request body shape: { "logs": [ ... ] }
export const ingestBodySchema = z.object({
  logs: z.array(z.unknown()).min(1, "logs must be a non-empty array"),
});
