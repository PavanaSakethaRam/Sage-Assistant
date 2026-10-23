import { describe, expect, it } from "vitest";
import fixtures from "../../tests/fixtures/contracts.json";
import parity from "../../tests/fixtures/text-parity.json";
import {
  parseNoteContent,
  parseRequest,
  parseResponse,
  parseProgress,
  MAX_FRAME_BYTES,
} from "../shared/contracts";
const req = (method: string, params: unknown = {}) => ({
  version: 1,
  id: "a",
  kind: "request",
  method,
  params,
});
describe("closed renderer contracts", () => {
  it("accepts shared literal content without normalization", () => {
    expect(parseNoteContent(fixtures.NoteContent)).toEqual(
      fixtures.NoteContent,
    );
    expect(
      parseResponse(
        {
          version: 1,
          id: "a",
          kind: "response",
          result: fixtures.ActionProposal,
        },
        "notes.propose",
      ),
    ).toMatchObject({ result: fixtures.ActionProposal });
  });
  for (const row of parity)
    it(`preserves Python text semantics: ${row.label}`, () => {
      if (row.valid)
        expect(parseNoteContent({ title: row.title, body: row.body })).toEqual({
          title: row.title,
          body: row.body,
        });
      else
        expect(() =>
          parseNoteContent({ title: row.title, body: row.body }),
        ).toThrow("Invalid contract");
    });
  it("counts astral and combining code points rather than UTF16 units", () => {
    expect(
      parseRequest(
        req("notes.propose", {
          title: "😀".repeat(200),
          body: "😀".repeat(100000),
        }),
      ).method,
    ).toBe("notes.propose");
    for (const title of ["😀".repeat(201), "e\u0301".repeat(100) + "x"])
      expect(() =>
        parseRequest(req("notes.propose", { title, body: "x" })),
      ).toThrow();
    expect(
      parseRequest(
        req("reasoning.start", {
          user_text: "😀".repeat(32000),
          attached_context: ["😀".repeat(64000)],
          backend: "copilot",
        }),
      ).method,
    ).toBe("reasoning.start");
    expect(() =>
      parseRequest(
        req("reasoning.start", {
          user_text: "x",
          attached_context: ["😀".repeat(32000), "x".repeat(32001)],
          backend: "copilot",
        }),
      ),
    ).toThrow();
  });
  it("rejects paths, generic methods, control envelopes, duplicate authority and unsafe scalars", () => {
    for (const value of [
      req("core.start", { executable: "/evil" }),
      req("settings.get", { executable: "/evil" }),
      { ...req("settings.get"), executable: "/evil" },
      { ...req("settings.get"), version: true },
      { ...req("settings.get"), kind: "host_copilot_selection" },
      req("notes.decide", {
        proposal_id: "a",
        revision: 1,
        decision: "save",
        approval: {},
      }),
      req("notes.list", { limit: true }),
      req("notes.list", { offset: -1 }),
      req("notes.list", { limit: 101 }),
      req("settings.update", {
        ai_mode: "local",
        reasoning_backend: "copilot",
      }),
      req("reasoning.start", { user_text: "\ud800", backend: "copilot" }),
    ])
      expect(() => parseRequest(value)).toThrow("Invalid contract");
    expect(() =>
      parseRequest({ ...req("settings.get"), timeout_ms: 30001 }),
    ).toThrow();
    expect(() =>
      parseRequest({ ...req("settings.get"), id: "x".repeat(65) }),
    ).toThrow();
  });
  it("rejects over-1MiB JSON at renderer and validates closed terminal/progress output", () => {
    expect(MAX_FRAME_BYTES).toBe(1048576);
    expect(() =>
      parseRequest(
        req("reasoning.start", {
          user_text: "x",
          attached_context: Array(64000).fill(""),
          backend: "copilot",
          model: "x".repeat(1048576),
        }),
      ),
    ).toThrow();
    for (const value of [
      { version: 2, id: "a", kind: "error", code: "cancelled" },
      { version: 1, id: "a", kind: "error", code: "secret" },
      {
        version: 1,
        id: "a",
        kind: "response",
        result: { ai_mode: "local", reasoning_backend: null, token: "x" },
      },
    ])
      expect(() => parseResponse(value, "settings.get")).toThrow();
    expect(
      parseProgress({
        version: 1,
        id: "a",
        kind: "progress",
        status: "started",
        task_id: "t",
      }),
    ).toMatchObject({ task_id: "t" });
    expect(() =>
      parseProgress({
        version: 1,
        id: "a",
        kind: "progress",
        status: "started",
        task_id: "t",
        token: "x",
      }),
    ).toThrow();
  });
  it.each(["connection.test", "readiness.list"] as const)(
    "%s accepts ready evidence from the reviewed provider",
    (method) => {
      const ready = {
        provider: "copilot",
        status: "ready",
        evidence: ["explicit_synthetic_check"],
        version: "sdk:1.0.25/runtime:1.0.102",
        destination: "GitHub Copilot cloud",
        explanation: "explicit_connection_check_succeeded",
        diagnostic: null,
      };
      const response = {
        version: 1,
        id: "ready",
        kind: "response",
        result: method === "readiness.list" ? { items: [ready] } : ready,
      };
      expect(parseResponse(response, method)).toEqual(response);
    },
  );
  it.each([
    "token_source",
    "session_storage",
    "sdk_import",
    "sdk_construct",
    "runtime_start",
    "runtime_status",
    "session_create",
    "response_wait",
  ])("accepts only closed provider diagnostic metadata at %s", (stage) => {
    const response = {
      version: 1,
      id: "r",
      kind: "response",
      result: {
        ...fixtures.ProviderReadiness,
        diagnostic: { stage, category: "unexpected_error" },
      },
    };
    expect(parseResponse(response, "connection.test")).toEqual(response);
    for (const diagnostic of [
      { stage: "raw error", category: "unexpected_error" },
      { stage, category: "raw error" },
      { stage, category: "io_error", message: "private" },
    ]) {
      expect(() =>
        parseResponse(
          { ...response, result: { ...response.result, diagnostic } },
          "connection.test",
        ),
      ).toThrow();
    }
  });
  it("accepts every existing method with defaults and validates all shared result shapes", () => {
    for (const method of [
      "settings.get",
      "settings.update",
      "readiness.list",
      "connection.test",
      "notes.list",
      "tasks.list",
      "app.shutdown",
    ])
      expect(parseRequest(req(method)).method).toBe(method);
    for (const [method, params] of Object.entries({
      "notes.search": { query: "" },
      "notes.get": { note_id: "n" },
      "tasks.get": { task_id: "t" },
      "tasks.cancel": { task_id: "t" },
      "notes.revise": { proposal_id: "p", revision: 2, title: "t", body: "b" },
      "notes.decide": { proposal_id: "p", revision: 1, decision: "cancel" },
      "reasoning.cancel": { request_id: "r" },
      "external.open": { url: "https://example.com/" },
    }))
      expect(parseRequest(req(method, params)).method).toBe(method);
    for (const [method, result] of Object.entries({
      "notes.get": fixtures.Note,
      "notes.decide": fixtures.ActionResult,
      "settings.get": { ai_mode: "local", reasoning_backend: null },
      "readiness.list": { items: [fixtures.ProviderReadiness] },
      "connection.test": fixtures.ProviderReadiness,
      "reasoning.start": {
        status: "completed",
        task_id: "t",
        text: "literal",
        proposal: fixtures.ActionProposal,
        usage: { input_tokens: 1, output_tokens: null },
      },
      "tasks.get": {
        id: "t",
        status: "pending",
        created_at: fixtures.Note.created_at,
        updated_at: fixtures.Note.updated_at,
        proposal: fixtures.ActionProposal,
        review_required: true,
        outcome: null,
      },
      "notes.list": {
        items: [
          Object.fromEntries(
            Object.entries(fixtures.Note).filter(([k]) => k !== "body"),
          ),
        ],
        next_offset: null,
      },
      "tasks.list": { items: [], next_offset: 20 },
      "reasoning.cancel": { status: "unknown_request" },
      "app.shutdown": { status: "shutting_down" },
      "external.open": { status: "opened" },
    }))
      expect(
        parseResponse(
          { version: 1, id: "a", kind: "response", result },
          method as Parameters<typeof parseResponse>[1],
        ),
      ).toHaveProperty("result");
  });
});
