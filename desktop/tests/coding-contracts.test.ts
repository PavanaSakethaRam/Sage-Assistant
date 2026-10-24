import { describe, expect, it } from "vitest";
import corpus from "../../tests/fixtures/coding-contracts.json";
import { FrameDecoder } from "../shared/framing";
import {
  disclosureHash,
  contextHash,
  type CodeDraft,
  parseCodeAck,
  parseCodeGrant,
  parseCodeIntent,
  parseCodeContext,
  parseCodeJobPage,
  parseCodeJobView,
  parseCodeModelRequest,
  parseCodePage,
  parseCodeProposal,
  parseCodeReceipt,
  parseCodeReview,
  parseCodeStart,
  parseTestRecipe,
  providerContext,
  recipeHash,
} from "../shared/coding-contracts";
import {
  BINDING,
  HASH,
  makeContext,
  makeFile,
  makeProposal,
  makeReceipt,
} from "./coding-fixtures";

describe("closed coding contracts", () => {
  it("matches every shared fixture row", () => {
    for (const row of corpus.cases) {
      const parse = () => {
        switch (row.kind) {
          case "context":
            return parseCodeContext(row.value);
          case "proposal":
            return parseCodeProposal(row.value, parseCodeContext(row.context));
          case "job_view":
            return parseCodeJobView(row.value);
          case "receipt":
            return parseCodeReceipt(row.value);
          case "ack":
            return parseCodeAck(row.value);
          case "recipe":
            return parseTestRecipe(row.value);
          case "start":
            return parseCodeStart(row.value);
          case "model_request":
            return parseCodeModelRequest(row.value);
          case "intent":
            return parseCodeIntent(row.value);
          case "review":
            return parseCodeReview(row.value);
          case "grant":
            return parseCodeGrant(row.value);
          case "page":
            return parseCodePage(row.value);
          case "job_page":
            return parseCodeJobPage(row.value);
          default:
            throw new Error(row.kind);
        }
      };
      if (row.valid) expect(parse(), row.label).toBeDefined();
      else expect(parse, row.label).toThrow();
    }
  });

  it("accepts exactly four creation outputs and one selected replacement", () => {
    const create = parseCodeContext(makeContext());
    expect(
      parseCodeProposal(makeProposal(), create).files.map((f) => f.name),
    ).toEqual(["index.html", "focus.js", "focus.test.mjs", "README.md"]);
    const replace = parseCodeContext(
      makeContext({
        mode: "replace_focus_file",
        target: "index.html",
        files: [makeFile()],
      }),
    );
    expect(
      parseCodeProposal(
        makeProposal({ files: [{ name: "index.html", text: "updated\n" }] }),
        replace,
      ).files,
    ).toHaveLength(1);
    for (const files of [
      makeProposal().files.slice(0, 3),
      Array(4).fill(makeProposal().files[0]),
      Array(4).fill({ name: "../index.html", text: "x" }),
      [{ name: "index.html", text: "x", command: "rm -rf" }],
    ])
      expect(() =>
        parseCodeProposal(makeProposal({ files }), create),
      ).toThrow();
    expect(() =>
      parseCodeProposal(
        makeProposal({ files: [{ name: "focus.js", text: "x" }] }),
        replace,
      ),
    ).toThrow();
  });

  it.each([
    ["😀".repeat(32000), true],
    ["😀".repeat(32001), false],
    ["a\0b", false],
    ["a\u0001b", false],
    ["a\ud800b", false],
    ["\ufeffa", false],
    ["a\r\nb", false],
  ] as const)("enforces literal proposed source limits", (value, valid) => {
    const files = makeProposal().files;
    files[0] = { name: "index.html", text: value };
    const parse = () =>
      parseCodeProposal(
        makeProposal({ files }),
        parseCodeContext(makeContext()),
      );
    if (valid) expect(parse().files[0].text).toBe(value);
    else expect(parse).toThrow();
  });

  it("enforces 64000 total source and 2000 explanation code points", () => {
    const base = makeProposal().files;
    const names = base.reduce((sum, file) => sum + [...file.name].length, 0);
    const files = [
      { name: "index.html", text: "a".repeat(32000) },
      { name: "focus.js", text: "b".repeat(32000 - names) },
      { name: "focus.test.mjs", text: "" },
      { name: "README.md", text: "" },
    ];
    const context = parseCodeContext(makeContext());
    expect(
      parseCodeProposal(
        makeProposal({ files, explanation: "😀".repeat(2000) }),
        context,
      ),
    ).toBeDefined();
    files[1] = { ...files[1], text: files[1].text + "x" };
    expect(() => parseCodeProposal(makeProposal({ files }), context)).toThrow();
    expect(() =>
      parseCodeProposal(
        makeProposal({ explanation: "😀".repeat(2001) }),
        context,
      ),
    ).toThrow();
  });

  it("sends only approved relative source records to the provider", () => {
    const context = parseCodeContext(
      makeContext({
        mode: "replace_focus_file",
        target: "index.html",
        files: [makeFile({ text: "user-marker\n" })],
        diagnostics: ["selected diagnostic"],
      }),
    );
    expect(providerContext(context)).toEqual([
      { name: "index.html", text: "user-marker\n" },
    ]);
    const serialized = JSON.stringify(providerContext(context));
    for (const privateValue of [
      "owner-marker",
      "root_file_id",
      "file_id",
      "document_version",
      "selected diagnostic",
    ])
      expect(serialized).not.toContain(privateValue);
  });

  it("rejects extra execution and loose identity fields", () => {
    expect(() =>
      parseCodeContext({ ...makeContext(), command: "node other.js" }),
    ).toThrow();
    expect(() =>
      parseCodeReceipt({ ...makeReceipt(), output: "secret" }),
    ).toThrow();
    expect(() =>
      parseCodeContext(
        makeContext({ binding: { ...BINDING, job_id: "has space" } }),
      ),
    ).toThrow();
    expect(() =>
      parseCodeContext(makeContext({ context_hash: HASH.toUpperCase() })),
    ).toThrow();
    expect(() =>
      parseCodeContext(
        makeContext({ binding: { ...BINDING, revision: true } }),
      ),
    ).toThrow();
  });

  it("enforces the prompt and selected diagnostic codepoint budget", () => {
    const start = {
      job_id: "job-1",
      revision: 1,
      account_generation: 1,
      user_text: "😀".repeat(32000),
      backend: "copilot",
      disclosure_hash: HASH,
    };
    expect(parseCodeStart(start).user_text).toBe(start.user_text);
    expect(() =>
      parseCodeStart({ ...start, user_text: "😀".repeat(32001) }),
    ).toThrow();
    const metadata =
      [..."replace_focus_file"].length + 2 * [..."index.html"].length;
    const context = makeContext({
      mode: "replace_focus_file",
      target: "index.html",
      files: [makeFile({ text: "a".repeat(32000) })],
      diagnostics: ["b".repeat(64000 - 32000 - metadata)],
    });
    expect(parseCodeContext(context)).toBeDefined();
    expect(() =>
      parseCodeContext({
        ...context,
        diagnostics: ["b".repeat(64001 - 32000 - metadata)],
      }),
    ).toThrow();
  });

  it("computes shared disclosure digests with browser WebCrypto", async () => {
    for (const row of corpus.hash_vectors) {
      const view = parseCodeJobView(row.view);
      expect(await disclosureHash(view, row.draft as CodeDraft)).toBe(
        row.expected,
      );
    }
    const first = corpus.hash_vectors[0];
    expect(
      await disclosureHash(parseCodeJobView(first.view), {
        ...first.draft,
        user_text: "changed",
      } as CodeDraft),
    ).not.toBe(first.expected);
  });

  it("hashes the complete selected snapshot including private root identity", async () => {
    for (const row of corpus.context_hash_vectors) {
      const context = parseCodeContext(row.context);
      expect(await contextHash(context)).toBe(row.expected);
      expect(
        await contextHash(
          parseCodeContext({ ...row.context, root_uri: "file:///changed" }),
        ),
      ).not.toBe(row.expected);
    }
  });

  it("hashes the exact fixed test recipe and constructed environment", async () => {
    for (const row of corpus.recipe_vectors) {
      const recipe = parseTestRecipe(row.recipe);
      expect(await recipeHash(recipe)).toBe(row.expected);
      if ("python_wire" in row) {
        const pythonWire = parseTestRecipe(row.python_wire);
        expect(await recipeHash(pythonWire)).toBe(row.expected);
      }
      const changed = parseTestRecipe({
        ...row.recipe,
        environment: { ...row.recipe.environment, TEMP: "/new" },
      });
      expect(await recipeHash(changed)).not.toBe(row.expected);
    }
  });

  it("applies canonical UTC spellings and real calendar bounds across shared values", () => {
    const parsers = {
      recipe: parseTestRecipe,
      model_request: parseCodeModelRequest,
      job_view: parseCodeJobView,
      grant: parseCodeGrant,
    };
    for (const row of corpus.utc_cases) {
      const base = corpus.cases.find(
        (candidate) => candidate.kind === row.kind && candidate.valid,
      );
      expect(base).toBeDefined();
      const candidate = { ...base!.value, [row.field]: row.value };
      const parse = parsers[row.kind as keyof typeof parsers];
      if (row.valid) {
        const parsed = parse(candidate) as unknown as Record<string, unknown>;
        expect(parsed[row.field], row.label).toBe(row.value);
      } else expect(() => parse(candidate), row.label).toThrow();
    }
  });

  it("rejects escaped duplicate names in the existing frame decoder", () => {
    for (const body of [
      '{"job_id":"a","job_\\u0069d":"b"}',
      '{"files":[{"name":"index.html","na\\u006de":"focus.js"}]}',
    ]) {
      const bytes = Buffer.from(body);
      const frame = Buffer.alloc(4 + bytes.length);
      frame.writeUInt32BE(bytes.length);
      bytes.copy(frame, 4);
      expect(() => new FrameDecoder().push(frame)).toThrow();
    }
  });

  it("rejects a job page beyond the serialized frame limit", () => {
    const view = corpus.cases.find(
      (row) => row.kind === "job_view" && row.valid,
    );
    expect(view).toBeDefined();
    const largeView = {
      ...view!.value,
      receipts: Array.from({ length: 100 }, () => makeReceipt()),
    };
    expect(() =>
      parseCodeJobPage({
        items: Array(100).fill(largeView),
        next_offset: null,
      }),
    ).toThrow();
  });
});

it("binds the literal approved proposal vector and cancellation flag", async () => {
  const { proposalHash } = await import("../shared/coding-contracts");
  const context = parseCodeContext(makeContext());
  const proposal = parseCodeProposal(makeProposal(), context);
  expect(await proposalHash(proposal, context, "code.create")).toBe(
    "e8acf85444adbdbf21f141c6f64607654ecd6769002368b043ba5146e9d5cfa3",
  );
  expect(
    await proposalHash(
      { ...proposal, explanation: "Changed" },
      context,
      "code.create",
    ),
  ).not.toBe(
    "e8acf85444adbdbf21f141c6f64607654ecd6769002368b043ba5146e9d5cfa3",
  );
  const view = corpus.cases.find(
    (row) => row.kind === "job_view" && row.valid,
  )!.value;
  expect(parseCodeJobView(view).cancel_requested).toBe(false);
  expect(() => parseCodeJobView({ ...view, cancel_requested: 1 })).toThrow();
});

it("checks shared proposal vectors and literal source/order changes", async () => {
  const { proposalHash } = await import("../shared/coding-contracts");
  for (const row of corpus.proposal_vectors) {
    const context = parseCodeContext(row.context);
    const proposal = parseCodeProposal(row.proposal, context);
    expect(await proposalHash(proposal, context, "code.create")).toBe(
      row.expected,
    );
    expect(
      await proposalHash(
        {
          ...proposal,
          files: proposal.files.map((file) => ({
            ...file,
            text: file.text + "changed",
          })),
        },
        context,
        "code.create",
      ),
    ).not.toBe(row.expected);
    expect(
      await proposalHash(
        { ...proposal, files: [...proposal.files].reverse() },
        context,
        "code.create",
      ),
    ).not.toBe(row.expected);
  }
});

it("matches independent literal Python journal projection and normalized receipt vectors", async () => {
  const { intentProjection, receiptProjection, journalHash } =
    await import("../../extension/src/journal");
  for (const vector of corpus.journal_vectors) {
    const value =
      vector.kind === "intent"
        ? intentProjection(parseCodeIntent(vector.input))
        : receiptProjection(parseCodeReceipt(vector.input));
    expect(value, vector.label).toEqual(vector.projection);
    expect(journalHash(value), vector.label).toBe(vector.canonical_sha256);
  }
});

it("closes private coding control inputs and correlates every private reply", async () => {
  const {
    parseCodingControlInput,
    parseHostCodingControl,
    parseHostCodingReply,
  } = await import("../shared/coding-contracts");
  const cases = corpus.cases;
  const good = (kind: string) =>
    cases.find((row) => row.kind === kind && row.valid)!.value;
  const now = Date.now();
  const inputs = [
    {
      operation: "context",
      params: {
        context: makeContext(),
        captured_at_ms: now - 1,
        expires_at_ms: now + 10000,
      },
    },
    { operation: "proposal_get", params: { job_id: "job-1" } },
    { operation: "finish", params: { job_id: "job-1" } },
    { operation: "test_prepare", params: good("recipe") },
    { operation: "review", params: good("review") },
    { operation: "intent", params: good("intent") },
    { operation: "observation", params: good("receipt") },
    { operation: "revoke_pair", params: { pair_id: "pair-1" } },
  ];
  for (const input of inputs) {
    expect(parseCodingControlInput(input)).toEqual(input);
    const control = parseHostCodingControl({
      ...input,
      version: 1,
      kind: "host_coding",
      id: "control",
      host_boot_id: "b".repeat(32),
      generation: 1,
    });
    const result = ["context", "finish", "test_prepare"].includes(
      input.operation,
    )
      ? good("job_view")
      : input.operation === "proposal_get"
        ? makeProposal()
        : input.operation === "review"
          ? { kind: "grant", grant: good("grant") }
          : input.operation === "revoke_pair"
            ? { status: "revoked" }
            : good("ack");
    const reply = { ...control, kind: "host_coding_reply", result };
    const response = Object.fromEntries(
      Object.entries(reply).filter(([key]) => key !== "params"),
    );
    expect(parseHostCodingReply(response, control).operation).toBe(
      input.operation,
    );
    expect(() =>
      parseHostCodingReply({ ...response, generation: 2 }, control),
    ).toThrow();
    expect(() =>
      parseHostCodingReply({ ...response, result: { command: "x" } }, control),
    ).toThrow();
    expect(() =>
      parseCodingControlInput({
        ...input,
        params: { ...input.params, command: "x" },
      }),
    ).toThrow();
  }
  for (const input of [
    { operation: "execute", params: {} },
    { operation: "finish", params: { job_id: "job-1" }, host_boot_id: "x" },
  ])
    expect(() => parseCodingControlInput(input)).toThrow();
  expect(() =>
    parseHostCodingControl({
      ...inputs[0],
      version: true,
      kind: "host_coding",
      id: "x",
      host_boot_id: "invalid",
      generation: 0,
    }),
  ).toThrow();
});
