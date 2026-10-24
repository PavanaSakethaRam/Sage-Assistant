import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  CoreRequest,
  Results,
  Method,
  SageApi,
  Proposal,
} from "../shared/contracts";
afterEach(cleanup);
export const proposal: Proposal = {
  id: "proposal_1",
  task_id: "task_1",
  tool: "notes.create",
  arguments: { title: "Literal title", body: "Full body\n\t**literal**" },
  revision: 1,
  scope: "notes",
};
export const date = "2026-10-22T12:00:00Z";
export function fixture(
  overrides: Partial<{
    [M in Method]: (
      params: CoreRequest["params"],
      request: CoreRequest,
    ) => unknown;
  }> = {},
) {
  const calls: CoreRequest[] = [];
  const defaults: Partial<Results> = {
    "editor.status": null,
    "editor.pair": null,
    "editor.confirm": null,
    "editor.disconnect": null,
    "coding.list": { items: [], next_offset: null },
    "settings.get": { ai_mode: "local", reasoning_backend: null },
    "readiness.list": {
      items: [
        {
          provider: "local",
          status: "unavailable",
          evidence: [],
          version: null,
          destination: null,
          explanation: "Local inference is not installed.",
          diagnostic: null,
        },
        {
          provider: "copilot",
          status: "auth_required",
          evidence: ["metadata_only"],
          version: "1.0.102",
          destination: "GitHub Copilot cloud",
          explanation: "Choose an account, then explicitly test.",
          diagnostic: null,
        },
        {
          provider: "api",
          status: "unavailable",
          evidence: [],
          version: null,
          destination: null,
          explanation: "API adapter unavailable.",
          diagnostic: null,
        },
      ],
    },
    "notes.list": { items: [], next_offset: null },
    "notes.search": { items: [], next_offset: null },
    "tasks.list": { items: [], next_offset: null },
    "notes.propose": proposal,
    "notes.revise": { ...proposal, revision: 2 },
    "notes.decide": {
      task_id: "task_1",
      operation_id: "op_1",
      status: "succeeded",
      note_id: "note_1",
      diagnostic: null,
    },
    "notes.get": {
      id: "note_1",
      ...proposal.arguments,
      task_id: "task_1",
      created_at: date,
      updated_at: date,
    },
    "external.open": { status: "opened" },
    "copilot.chooseAccount": { status: "selected" },
    "copilot.disconnect": { status: "cleared" },
    "reasoning.cancel": { status: "cancelled" },
    "connection.test": { status: "unavailable", code: "inference_unavailable" },
  };
  const api: SageApi = {
    request: vi.fn(async (request: CoreRequest) => {
      calls.push(request);
      const handler = overrides[request.method];
      const result = handler
        ? await handler(request.params, request)
        : request.method === "settings.update"
          ? request.params
          : request.method === "notes.decide" &&
              "decision" in request.params &&
              request.params.decision === "cancel"
            ? {
                task_id: "task_1",
                operation_id: null,
                status: "cancelled",
                note_id: null,
                diagnostic: null,
              }
            : defaults[request.method];
      return {
        version: 1,
        id: request.id,
        kind: "response",
        result,
      } as Awaited<ReturnType<SageApi["request"]>>;
    }),
    onProgress: () => () => {},
  };
  return { api, calls };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
