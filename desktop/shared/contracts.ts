/** Closed renderer protocol. This module also runs in the sandboxed preload: no Node APIs. */
export const MAX_FRAME_BYTES = 1_048_576;
export const REQUEST_CHANNEL = "sage:request";
export const PROGRESS_CHANNEL = "sage:progress";
export type Backend = "copilot" | "local" | "api";
export type NoteContent = { title: string; body: string };
export type Settings = {
  ai_mode: "local" | "assistant" | "api";
  reasoning_backend: Backend | null;
};
export type Proposal = {
  id: string;
  task_id: string;
  tool: "notes.create";
  arguments: NoteContent;
  revision: number;
  scope: "notes";
};
export type ActionResult = {
  task_id: string | null;
  operation_id: string | null;
  status:
    "succeeded" | "failed" | "cancelled" | "rejected" | "needs_reconciliation";
  note_id: string | null;
  diagnostic: string | null;
};
export type NoteSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  task_id: string | null;
};
export type TaskSummary = {
  id: string;
  status:
    | "pending"
    | "succeeded"
    | "cancelled"
    | "rejected"
    | "reasoning"
    | "interrupted"
    | "completed"
    | "failed";
  created_at: string;
  updated_at: string;
};
export type Readiness = {
  provider: Backend;
  status:
    | "unavailable"
    | "not_configured"
    | "auth_required"
    | "incompatible"
    | "ready"
    | "error";
  evidence: string[];
  version: string | null;
  destination: string | null;
  explanation: string;
};
export type Page<T> = { items: T[]; next_offset: number | null };
type PageInput = { limit?: number; offset?: number };
export type Params = {
  "settings.get": Record<string, never>;
  "settings.update": Partial<Settings>;
  "readiness.list": Record<string, never>;
  "connection.test": Record<string, never>;
  "reasoning.start": {
    user_text: string;
    attached_context?: string[];
    backend: Backend;
    model?: string | null;
  };
  "reasoning.cancel": { request_id: string };
  "notes.propose": NoteContent;
  "notes.revise": NoteContent & { proposal_id: string; revision: number };
  "notes.decide": {
    proposal_id: string;
    revision: number;
    decision: "save" | "cancel";
  };
  "notes.list": PageInput;
  "notes.search": PageInput & { query: string };
  "notes.get": { note_id: string };
  "tasks.list": PageInput;
  "tasks.get": { task_id: string };
  "tasks.cancel": { task_id: string };
  "app.shutdown": Record<string, never>;
  "external.open": { url: string };
};
export type Method = keyof Params;
export type CoreRequest = {
  [M in Method]: {
    version: 1;
    id: string;
    kind: "request";
    method: M;
    params: Params[M];
    timeout_ms?: number;
  };
}[Method];
type Unavailable = { status: "unavailable"; code: "inference_unavailable" };
export type Results = {
  "settings.get": Settings;
  "settings.update": Settings;
  "readiness.list": { items: Readiness[] };
  "connection.test": Readiness | Unavailable;
  "reasoning.start":
    | Unavailable
    | {
        status: "completed" | "error" | "cancelled";
        task_id: string;
        text: string;
        proposal: Proposal | null;
        usage: {
          input_tokens: number | null;
          output_tokens: number | null;
        } | null;
      };
  "reasoning.cancel": { status: "cancelled" | "unknown_request" };
  "notes.propose": Proposal;
  "notes.revise": Proposal;
  "notes.decide": ActionResult;
  "notes.get": NoteSummary & { body: string };
  "notes.list": Page<NoteSummary>;
  "notes.search": Page<NoteSummary>;
  "tasks.list": Page<TaskSummary>;
  "tasks.get": TaskSummary & {
    proposal: Proposal | null;
    review_required: boolean;
    outcome: ActionResult | null;
  };
  "tasks.cancel": ActionResult;
  "app.shutdown": { status: "shutting_down" };
  "external.open": { status: "opened" | "unavailable" };
};
const errorCodes = [
  "invalid_frame",
  "invalid_request",
  "duplicate_id",
  "session_limit",
  "busy",
  "timeout",
  "cancelled",
  "unknown_request",
  "not_found",
  "internal_error",
  "shutting_down",
] as const;
export type ErrorCode = (typeof errorCodes)[number];
export type CoreResponse =
  | { version: 1; id: string; kind: "response"; result: Results[Method] }
  | { version: 1; id: string | null; kind: "error"; code: ErrorCode };
export type Progress = {
  version: 1;
  id: string;
  kind: "progress";
  status: "started";
  task_id: string;
};
export type SageApi = {
  request(request: CoreRequest): Promise<CoreResponse>;
  onProgress(handler: (progress: Progress) => void): () => void;
};

type RecordValue = Record<string, unknown>;
function invalid(): never {
  throw new TypeError("Invalid contract");
}
function object(
  value: unknown,
  required: string[],
  optional: string[] = [],
): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const row = value as RecordValue;
  if (
    required.some((k) => !Object.hasOwn(row, k)) ||
    Object.keys(row).some((k) => !required.includes(k) && !optional.includes(k))
  )
    return invalid();
  return row;
}
function literal(value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) invalid();
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
}
function string(
  value: unknown,
  max = MAX_FRAME_BYTES,
): asserts value is string {
  if (
    typeof value !== "string" ||
    [...value].length > max ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    invalid();
}
function text(
  value: unknown,
  max: number,
  multiline: boolean,
  nonblank = false,
): void {
  string(value, max);
  // Python rejects Cc/Cs first; str.strip then agrees with Unicode White_Space
  // for the remaining code points. FEFF and zero-width characters remain literal.
  const forbidden = multiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
    : /[\u0000-\u001F\u007F-\u009F]/u;
  if (forbidden.test(value) || (nonblank && !/[^\p{White_Space}]/u.test(value)))
    invalid();
}
function id(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    invalid();
}
function nullable(value: unknown, check: (value: unknown) => void): void {
  if (value !== null) check(value);
}
function array(
  value: unknown,
  check: (value: unknown) => void,
  max = 100,
): void {
  if (!Array.isArray(value) || value.length > max) invalid();
  value.forEach(check);
}
function bounded(value: unknown): void {
  try {
    if (
      new TextEncoder().encode(JSON.stringify(value)).length > MAX_FRAME_BYTES
    )
      invalid();
  } catch {
    invalid();
  }
}
function note(value: unknown): void {
  const r = object(value, ["title", "body"]);
  text(r.title, 200, false, true);
  text(r.body, 100000, true, true);
}
export function parseNoteContent(value: unknown): NoteContent {
  note(value);
  return value as NoteContent;
}
const backends = ["copilot", "local", "api"];
function settings(value: unknown, partial = false): void {
  const r = object(
    value,
    partial ? [] : ["ai_mode", "reasoning_backend"],
    partial ? ["ai_mode", "reasoning_backend"] : [],
  );
  if (Object.hasOwn(r, "ai_mode"))
    literal(r.ai_mode, ["local", "assistant", "api"]);
  if (Object.hasOwn(r, "reasoning_backend"))
    nullable(r.reasoning_backend, (v) => literal(v, backends));
  if ((r.ai_mode ?? "local") === "local" && r.reasoning_backend != null)
    invalid();
}
function pageInput(r: RecordValue): void {
  if (Object.hasOwn(r, "limit")) integer(r.limit, 1, 100);
  if (Object.hasOwn(r, "offset")) integer(r.offset, 0, 1000000);
}
export function parseRequest(value: unknown): CoreRequest {
  bounded(value);
  const r = object(
    value,
    ["version", "id", "kind", "method", "params"],
    ["timeout_ms"],
  );
  literal(r.version, [1]);
  literal(r.kind, ["request"]);
  id(r.id);
  if (Object.hasOwn(r, "timeout_ms")) integer(r.timeout_ms, 1, 30000);
  switch (r.method) {
    case "settings.get":
    case "readiness.list":
    case "connection.test":
    case "app.shutdown":
      object(r.params, []);
      break;
    case "settings.update":
      settings(r.params, true);
      break;
    case "notes.propose":
      note(r.params);
      break;
    case "notes.revise": {
      const p = object(r.params, ["title", "body", "proposal_id", "revision"]);
      note({ title: p.title, body: p.body });
      id(p.proposal_id);
      integer(p.revision, 1);
      break;
    }
    case "notes.decide": {
      const p = object(r.params, ["proposal_id", "revision", "decision"]);
      id(p.proposal_id);
      integer(p.revision, 1);
      literal(p.decision, ["save", "cancel"]);
      break;
    }
    case "notes.get":
      id(object(r.params, ["note_id"]).note_id);
      break;
    case "tasks.get":
    case "tasks.cancel":
      id(object(r.params, ["task_id"]).task_id);
      break;
    case "reasoning.cancel":
      id(object(r.params, ["request_id"]).request_id);
      break;
    case "notes.list":
    case "tasks.list":
      pageInput(object(r.params, [], ["limit", "offset"]));
      break;
    case "notes.search": {
      const p = object(r.params, ["query"], ["limit", "offset"]);
      pageInput(p);
      text(p.query, 32000, true);
      break;
    }
    case "reasoning.start": {
      const p = object(
        r.params,
        ["user_text", "backend"],
        ["attached_context", "model"],
      );
      text(p.user_text, 32000, true);
      literal(p.backend, backends);
      if (Object.hasOwn(p, "model")) nullable(p.model, (v) => string(v, 200));
      if (Object.hasOwn(p, "attached_context")) {
        array(p.attached_context, (v) => text(v, 64000, true), 64000);
        if (
          (p.attached_context as string[]).reduce(
            (sum, s) => sum + [...s].length,
            0,
          ) > 64000
        )
          invalid();
      }
      break;
    }
    case "external.open":
      text(object(r.params, ["url"]).url, 2048, false, true);
      break;
    default:
      invalid();
  }
  return value as CoreRequest;
}
function proposal(value: unknown): void {
  const r = object(value, [
    "id",
    "task_id",
    "tool",
    "arguments",
    "revision",
    "scope",
  ]);
  id(r.id);
  id(r.task_id);
  literal(r.tool, ["notes.create"]);
  note(r.arguments);
  integer(r.revision, 1);
  literal(r.scope, ["notes"]);
}
function action(value: unknown): void {
  const r = object(value, [
    "task_id",
    "operation_id",
    "status",
    "note_id",
    "diagnostic",
  ]);
  for (const k of ["task_id", "operation_id", "note_id"]) nullable(r[k], id);
  literal(r.status, [
    "succeeded",
    "failed",
    "cancelled",
    "rejected",
    "needs_reconciliation",
  ]);
  nullable(r.diagnostic, string);
}
function date(value: unknown): void {
  string(value);
  if (
    !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    Number.isNaN(Date.parse(value))
  )
    invalid();
}
function summary(r: RecordValue, task = false): void {
  id(r.id);
  date(r.created_at);
  date(r.updated_at);
  if (task)
    literal(r.status, [
      "pending",
      "succeeded",
      "cancelled",
      "rejected",
      "reasoning",
      "interrupted",
      "completed",
      "failed",
    ]);
  else {
    text(r.title, 200, false, true);
    nullable(r.task_id, id);
  }
}
function readiness(value: unknown): void {
  const r = object(value, [
    "provider",
    "status",
    "evidence",
    "version",
    "destination",
    "explanation",
  ]);
  literal(r.provider, backends);
  literal(r.status, [
    "unavailable",
    "not_configured",
    "auth_required",
    "incompatible",
    "ready",
    "error",
  ]);
  array(r.evidence, string);
  nullable(r.version, string);
  nullable(r.destination, string);
  string(r.explanation);
}
function unavailable(r: RecordValue): boolean {
  if (Object.hasOwn(r, "code")) {
    object(r, ["status", "code"]);
    literal(r.status, ["unavailable"]);
    literal(r.code, ["inference_unavailable"]);
    return true;
  }
  return false;
}
function result(value: unknown, method: Method): void {
  switch (method) {
    case "settings.get":
    case "settings.update":
      settings(value);
      break;
    case "notes.propose":
    case "notes.revise":
      proposal(value);
      break;
    case "notes.decide":
    case "tasks.cancel":
      action(value);
      break;
    case "notes.get": {
      const r = object(value, [
        "id",
        "title",
        "body",
        "created_at",
        "updated_at",
        "task_id",
      ]);
      summary(r);
      text(r.body, 100000, true, true);
      break;
    }
    case "notes.list":
    case "notes.search":
    case "tasks.list": {
      const r = object(value, ["items", "next_offset"]);
      nullable(r.next_offset, (v) => integer(v, 0, 1000100));
      array(r.items, (v) => {
        const row = object(
          v,
          method === "tasks.list"
            ? ["id", "status", "created_at", "updated_at"]
            : ["id", "title", "created_at", "updated_at", "task_id"],
        );
        summary(row, method === "tasks.list");
      });
      break;
    }
    case "tasks.get": {
      const r = object(value, [
        "id",
        "status",
        "created_at",
        "updated_at",
        "proposal",
        "review_required",
        "outcome",
      ]);
      summary(r, true);
      nullable(r.proposal, proposal);
      literal(r.review_required, [true, false]);
      nullable(r.outcome, action);
      break;
    }
    case "readiness.list":
      array(object(value, ["items"]).items, readiness, 3);
      break;
    case "connection.test": {
      const r = object(
        value,
        [],
        [
          "status",
          "code",
          "provider",
          "evidence",
          "version",
          "destination",
          "explanation",
        ],
      );
      if (!unavailable(r)) readiness(r);
      break;
    }
    case "reasoning.start": {
      const r = object(
        value,
        [],
        ["status", "code", "task_id", "text", "proposal", "usage"],
      );
      if (!unavailable(r)) {
        object(r, ["status", "task_id", "text", "proposal", "usage"]);
        literal(r.status, ["completed", "error", "cancelled"]);
        id(r.task_id);
        string(r.text);
        nullable(r.proposal, proposal);
        nullable(r.usage, (v) => {
          const u = object(v, ["input_tokens", "output_tokens"]);
          nullable(u.input_tokens, integer);
          nullable(u.output_tokens, integer);
        });
      }
      break;
    }
    case "reasoning.cancel":
      literal(object(value, ["status"]).status, [
        "cancelled",
        "unknown_request",
      ]);
      break;
    case "app.shutdown":
      literal(object(value, ["status"]).status, ["shutting_down"]);
      break;
    case "external.open":
      literal(object(value, ["status"]).status, ["opened", "unavailable"]);
      break;
  }
}
export function parseResponse(value: unknown, method: Method): CoreResponse {
  bounded(value);
  const r = object(value, ["version", "id", "kind"], ["result", "code"]);
  literal(r.version, [1]);
  if (r.kind === "error") {
    object(r, ["version", "id", "kind", "code"]);
    nullable(r.id, id);
    literal(r.code, errorCodes);
  } else {
    literal(r.kind, ["response"]);
    object(r, ["version", "id", "kind", "result"]);
    id(r.id);
    result(r.result, method);
  }
  return value as CoreResponse;
}
export function parseProgress(value: unknown): Progress {
  bounded(value);
  const r = object(value, ["version", "id", "kind", "status", "task_id"]);
  literal(r.version, [1]);
  literal(r.kind, ["progress"]);
  literal(r.status, ["started"]);
  id(r.id);
  id(r.task_id);
  return value as Progress;
}
export function failure(id: string | null, code: ErrorCode): CoreResponse {
  return { version: 1, id, kind: "error", code };
}

declare global {
  interface Window {
    readonly sage: SageApi;
  }
}
