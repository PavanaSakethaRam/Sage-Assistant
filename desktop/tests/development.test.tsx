// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Development } from "../renderer/Development";
import { fixture, deferred } from "./renderer-fixture";
import { BINDING, HASH } from "./coding-fixtures";
import { parseCodeJobView, type CodeReceipt } from "../shared/coding-contracts";
import type { SageApi } from "../shared/contracts";
const pair = {
  host_boot_id: "host-1",
  pair_id: "pair-1",
  root_id: "root-1",
  root_uri: "file:///private/owned/focus",
  root_file_id: "root-file-1",
  window_id: "window-1",
  challenge: "1234-5678",
  status: "paired",
};
const job = (extra = {}) => ({
  binding: BINDING,
  mode: "create_focus_project",
  state: "context_ready",
  destination: "GitHub Copilot cloud",
  account: "synthetic",
  model: null,
  account_generation: 1,
  context_hash: HASH,
  file_count: 0,
  manifest: [],
  hashes: [],
  source_codepoints: 0,
  diagnostics_codepoints: 0,
  metadata_codepoints: 12,
  expires_at: new Date(Date.now() + 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z"),
  diagnostic: null,
  receipts: [],
  cancel_requested: false,
  ...extra,
});
function connected(overrides = {}) {
  const f = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
      coding_backend: "copilot",
    }),
    "editor.status": () => pair,
    "editor.pair": () => null,
    "editor.confirm": () => pair,
    "editor.disconnect": () => null,
    "coding.list": () => ({ items: [], next_offset: null }),
    "coding.start": () => job({ state: "proposing" }),
    "coding.cancel": () => job({ state: "cancelled", cancel_requested: true }),
    ...overrides,
  });
  let listener: Parameters<SageApi["onProgress"]>[0] | undefined;
  const off = vi.fn(() => {
    listener = undefined;
  });
  f.api.onProgress = (handler) => {
    listener = handler;
    return off;
  };
  return {
    ...f,
    off,
    emit(value: unknown) {
      act(() => listener?.(value as never));
    },
  };
}
it("keeps Send disabled when unpaired, exposes no effect control and never models on readiness", async () => {
  const { api, calls } = fixture({ "editor.status": () => null });
  render(<Development api={api} />);
  expect(
    await screen.findByRole("button", { name: "Send request" }),
  ).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Run once" })).toBeNull();
  expect(
    calls.some((c) =>
      ["coding.start", "connection.test", "reasoning.start"].includes(c.method),
    ),
  ).toBe(false);
  expect(await screen.findByText(/Local AI only/)).toBeInTheDocument();
});
it("discovers context accepted after mount, discloses exact counts and sends only literal reviewed prompt", async () => {
  const f = connected();
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  f.emit({ version: 1, kind: "coding_status", job: job() });
  expect(screen.getByText(/Selected files: 0/)).toBeInTheDocument();
  expect(screen.getByText(/Provider default.*unknown/)).toBeInTheDocument();
  expect(screen.getByText(/quota/)).toBeInTheDocument();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "  Build tracker 😀\n" } },
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send request" }));
  await waitFor(() =>
    expect(f.calls.filter((c) => c.method === "coding.start")).toHaveLength(1),
  );
  expect(
    f.calls.find((c) => c.method === "coding.start")?.params,
  ).toMatchObject({
    user_text: "  Build tracker 😀\n",
    backend: "copilot",
    revision: 1,
    account_generation: 1,
    model: null,
    disclosure_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(f.calls.some((c) => c.method === "coding.get")).toBe(false);
});
it("buffers status during snapshot, fences older pair/revision and clears immediately on revoke", async () => {
  const snapshot = deferred<unknown>();
  const f = connected({ "editor.status": () => snapshot.promise });
  render(<Development api={f.api} />);
  f.emit({
    version: 1,
    kind: "coding_status",
    job: job({
      context_hash: "b".repeat(64),
      binding: { ...BINDING, revision: 2 },
    }),
  });
  snapshot.resolve(pair);
  await screen.findByText("b".repeat(64), { exact: false });
  f.emit({ version: 1, kind: "coding_status", job: job() });
  f.emit({
    version: 1,
    kind: "coding_status",
    job: job({ binding: { ...BINDING, pair_id: "old" } }),
  });
  expect(
    screen.getByText("b".repeat(64), { exact: false }),
  ).toBeInTheDocument();
  f.emit({ version: 1, kind: "coding_cleared", pair_id: pair.pair_id });
  expect(screen.queryByText(pair.root_uri)).toBeNull();
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
});
it("rejects over-budget code points instead of truncating and invalidates edited disclosure", async () => {
  const f = connected();
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  f.emit({ version: 1, kind: "coding_status", job: job() });
  const prompt = screen.getByRole("textbox", { name: "Development prompt" });
  fireEvent.change(prompt, { target: { value: "😀".repeat(32000) } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled(),
  );
  fireEvent.change(prompt, { target: { value: "😀".repeat(32001) } });
  expect(prompt).toHaveValue("😀".repeat(32001));
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  expect(screen.getByText(/32001.*32000/)).toBeInTheDocument();
});
it("ignores late Send completion after prompt edit, cancellation and pair revocation", async () => {
  const start = deferred<unknown>();
  const f = connected({ "coding.start": () => start.promise });
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  f.emit({ version: 1, kind: "coding_status", job: job() });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "Build" } },
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send request" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "Changed" } },
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));
  await screen.findByText(/Job status: Request cancelled/);
  start.resolve(job({ state: "proposing" }));
  f.emit({
    version: 1,
    kind: "coding_status",
    job: job({ state: "proposing" }),
  });
  expect(screen.getByText(/Job status: Request cancelled/)).toBeInTheDocument();
  f.emit({ version: 1, kind: "coding_cleared", pair_id: pair.pair_id });
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
});
it("shows cancellation still pending during effects and honest partial observations", async () => {
  const f = connected({
    "coding.cancel": () => job({ state: "applying", cancel_requested: true }),
  });
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  f.emit({
    version: 1,
    kind: "coding_status",
    job: job({ state: "applying" }),
  });
  await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));
  expect(
    await screen.findByText(/Cancellation requested.*settlement/),
  ).toBeInTheDocument();
  f.emit({ version: 1, kind: "coding_status", job: job({ state: "partial" }) });
  expect(screen.getByText(/Job status: Partially applied/)).toBeInTheDocument();
  expect(screen.getByText(/Observed receipts only/)).toBeInTheDocument();
});
it("pairs and confirms only by explicit gestures; offers keyboard names and history on demand", async () => {
  const f = connected({
    "editor.status": () => null,
    "editor.pair": () => ({ ...pair, status: "awaiting_confirmation" }),
  });
  render(<Development api={f.api} />);
  const button = await screen.findByRole("button", { name: "Pair VS Code" });
  button.focus();
  await userEvent.keyboard("{Enter}");
  expect(
    await screen.findByText(pair.challenge, { exact: false }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm window and folder" }),
  );
  expect(
    f.calls.filter((c) => c.method === "editor.confirm").map((c) => c.params),
  ).toEqual([{}]);
  await userEvent.click(
    screen.getByRole("button", { name: "Load development history" }),
  );
  expect(f.calls.filter((c) => c.method === "coding.list")).toHaveLength(1);
  expect(
    screen.getByRole("status", { name: "Development status" }),
  ).toBeInTheDocument();
});
it("unsubscribes and rejects late context/snapshot work after unmount", async () => {
  const snapshot = deferred<unknown>();
  const f = connected({ "editor.status": () => snapshot.promise });
  const view = render(<Development api={f.api} />);
  view.unmount();
  snapshot.resolve(pair);
  f.emit({ version: 1, kind: "coding_status", job: job() });
  await act(async () => {});
  expect(f.off).toHaveBeenCalledOnce();
  expect(
    f.calls.some(
      (c) => c.method === "coding.get" || c.method === "coding.start",
    ),
  ).toBe(false);
});
it("expires selected context at its original deadline despite prompt edits or repeated status", async () => {
  const f = connected();
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  const value = job({
    expires_at: new Date(Date.now() + 150)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  });
  // The parser's whole-second form can already be expired; use a canonical six-digit fraction.
  value.expires_at = new Date(Date.now() + 150)
    .toISOString()
    .replace(/(\.\d{3})Z$/, "$1000Z");
  f.emit({ version: 1, kind: "coding_status", job: value });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "Expires" } },
  );
  f.emit({ version: 1, kind: "coding_status", job: value });
  await screen.findByText(/Selected context expired/);
  expect(
    screen.getByRole("textbox", { name: "Development prompt" }),
  ).toHaveValue("");
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
});
it("clears native gesture busy state on revocation and ignores the late native answer", async () => {
  const confirmation = deferred<unknown>();
  const f = connected({
    "editor.status": () => ({ ...pair, status: "awaiting_confirmation" }),
    "editor.confirm": () => confirmation.promise,
  });
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  await userEvent.click(
    screen.getByRole("button", { name: "Confirm window and folder" }),
  );
  expect(screen.getByRole("button", { name: "Pair VS Code" })).toBeDisabled();
  f.emit({ version: 1, kind: "coding_cleared", pair_id: pair.pair_id });
  expect(screen.getByRole("button", { name: "Pair VS Code" })).toBeEnabled();
  confirmation.resolve(pair);
  await act(async () => {});
  expect(screen.queryByText(pair.root_uri)).toBeNull();
});
it("keeps a newer Send pending when an earlier pair's Send settles late", async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  let starts = 0;
  let selected = pair;
  const f = connected({
    "editor.status": () => selected,
    "coding.start": () => (starts++ === 0 ? first.promise : second.promise),
  });
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  f.emit({ version: 1, kind: "coding_status", job: job() });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "First" } },
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send request" }));
  f.emit({ version: 1, kind: "coding_cleared", pair_id: pair.pair_id });
  selected = { ...pair, pair_id: "pair-2" };
  await userEvent.click(
    screen.getByRole("button", { name: "Refresh editor status" }),
  );
  const next = job({
    binding: { ...BINDING, job_id: "job-2", pair_id: "pair-2" },
  });
  f.emit({ version: 1, kind: "coding_status", job: next });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "Second" } },
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send request" }));
  first.resolve(job({ state: "proposing" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Send request" })).toBeDisabled();
  second.resolve({ ...next, state: "proposing" });
  await act(async () => {});
});

const receiptBase = {
  binding: { ...BINDING, policy_version: "code-v1" as const },
  operation_id: "operation-1",
  effect_id: "effect-1",
  ordinal: 0,
  expected_hash: "c".repeat(64),
};
const receiptCases: [CodeReceipt, string][] = [
  ...(
    [
      ["code.create", "created", "File created"],
      ["code.create", "partial", "Creation incomplete"],
      ["code.create", "needs_reconciliation", "Creation outcome unknown"],
      ["code.replace", "applied_saved", "Replacement saved"],
      ["code.replace", "applied_unsaved", "Replacement not saved"],
      ["code.replace", "needs_review", "Replacement needs review"],
      ["code.replace", "needs_reconciliation", "Replacement outcome unknown"],
    ] as const
  ).map(([scope, status, label]): [CodeReceipt, string] => [
    {
      ...receiptBase,
      scope,
      status,
      target: "focus.js",
      observed_hash: "d".repeat(64),
      observed_length: 23,
    } as CodeReceipt,
    label,
  ]),
  ...(
    [
      ["passed", "Tests passed"],
      ["failed", "Tests failed"],
      ["cancelled", "Test run cancelled"],
      ["changed_during_test", "Files changed during test"],
      ["unknown", "Test outcome unknown"],
      ["termination_unconfirmed", "Test termination unconfirmed"],
    ] as const
  ).map(([status, label]): [CodeReceipt, string] => [
    {
      ...receiptBase,
      scope: "code.test",
      status,
      environment_hash: "e".repeat(64),
      executable_hash: "f".repeat(64),
      executable_version: "26.12.1",
      exit_code: null,
      signal: null,
      cancel_requested: true,
      timeout: false,
      overflow: false,
      output_digest: "a".repeat(64),
    },
    label,
  ]),
];
// Removing readable outcomes or substituting a proposed/executable hash breaks these observations.
it.each(receiptCases)(
  "shows honest current and history receipt outcome %s",
  async (receipt, label) => {
    const value = parseCodeJobView(
      job({ state: "completed", receipts: [receipt] }),
    );
    const f = connected({
      "coding.list": () => ({ items: [value], next_offset: null }),
    });
    render(<Development api={f.api} />);
    await screen.findByText(pair.root_uri);
    f.emit({ version: 1, kind: "coding_status", job: value });
    const current = screen.getByRole("list", {
      name: "Observed development receipts",
    });
    const item = within(current).getByRole("listitem");
    // Baseline's unconditional pre is visibly expanded, even with a valid loaded receipt.
    const pre = item.querySelector("pre")!;
    expect(pre).toHaveTextContent(/operation-1/);
    expect(pre).not.toBeVisible();
    const details = pre.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(pre.textContent).toBe(JSON.stringify(receipt, null, 2));
    const summary = within(item).getByText("Technical receipt details");
    expect(summary.tagName).toBe("SUMMARY");
    summary.focus();
    await userEvent.tab({ shift: true });
    await userEvent.tab();
    expect(summary).toHaveFocus();
    await userEvent.click(summary);
    expect(details).toHaveAttribute("open");
    expect(pre).toBeVisible();
    await userEvent.click(summary);
    expect(details).not.toHaveAttribute("open");
    const concise = item.cloneNode(true) as HTMLElement;
    concise.querySelector("details")?.remove();
    expect(concise).toHaveTextContent(label);
    expect(concise).toHaveTextContent(
      receipt.scope === "code.test" ? "focus.test.mjs" : "focus.js",
    );
    expect(concise.textContent).not.toContain(receipt.expected_hash);
    if (receipt.scope === "code.test") {
      expect(concise.textContent).not.toMatch(/observed/i);
      expect(concise.textContent).not.toContain(receipt.executable_hash);
      expect(concise.textContent).not.toContain(receipt.output_digest!);
    } else expect(concise).toHaveTextContent("d".repeat(64));
    expect(
      screen.getByText(/Job status: Request completed/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Load development history" }),
    );
    const history = screen.getByRole("list", { name: "Development history" });
    expect(history).toHaveTextContent(label);
    expect(history).toHaveTextContent("Request completed");
    expect(history).toHaveTextContent(
      receipt.scope === "code.test" ? "focus.test.mjs" : "d".repeat(64),
    );
    expect(history.querySelector("details, pre")).toBeNull();
    expect(
      f.calls.some((c) =>
        [
          "coding.start",
          "coding.cancel",
          "reasoning.start",
          "connection.test",
        ].includes(c.method),
      ),
    ).toBe(false);
  },
);
it.each([undefined, null])(
  "marks absent actual file observation %s without substituting expected hash",
  async (observed) => {
    const receipt: CodeReceipt = {
      ...receiptBase,
      scope: "code.create",
      status: "partial",
      target: "README.md",
      ...(observed === undefined ? {} : { observed_hash: observed }),
    };
    const value = parseCodeJobView(
      job({ state: "partial", receipts: [receipt] }),
    );
    const f = connected({
      "coding.list": () => ({ items: [value], next_offset: null }),
    });
    render(<Development api={f.api} />);
    await screen.findByText(pair.root_uri);
    f.emit({ version: 1, kind: "coding_status", job: value });
    const current = screen.getByRole("list", {
      name: "Observed development receipts",
    });
    expect(
      within(current).getByText(/README.md.*Creation incomplete.*not observed/),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Load development history" }),
    );
    expect(
      screen.getByRole("list", { name: "Development history" }),
    ).toHaveTextContent(/README.md.*Creation incomplete.*not observed/);
  },
);
it.each([
  ["context_ready", "Context ready"],
  ["proposing", "Preparing proposal"],
  ["review_required", "Review required"],
  ["applying", "Applying reviewed changes"],
  ["applied_saved", "Changes saved"],
  ["applied_unsaved", "Changes not saved"],
  ["needs_review", "Review needed"],
  ["test_review", "Test review required"],
  ["testing", "Tests running"],
  ["completed", "Request completed"],
  ["rejected", "Request rejected"],
  ["cancelled", "Request cancelled"],
  ["failed", "Request failed"],
  ["partial", "Partially applied"],
  ["interrupted", "Interrupted"],
  ["needs_reconciliation", "Outcome needs inspection"],
])(
  "describes job %s without implying unobserved success",
  async (state, label) => {
    const value = parseCodeJobView(
      job({ state, diagnostic: "effect_failed", cancel_requested: true }),
    );
    const f = connected({
      "coding.list": () => ({ items: [value], next_offset: null }),
    });
    render(<Development api={f.api} />);
    await screen.findByText(pair.root_uri);
    f.emit({ version: 1, kind: "coding_status", job: value });
    expect(
      screen.getByText(`Job status: ${label} · effect_failed`),
    ).toBeVisible();
    if (state === "applied_saved")
      expect(screen.getByText(/Tests have not run/)).toBeVisible();
    if (state === "applied_unsaved")
      expect(screen.getByText(/Replacement remains unsaved/)).toBeVisible();
    if (state === "testing")
      expect(
        screen.getByText(/Cancellation requested.*settlement/),
      ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Load development history" }),
    );
    expect(
      screen.getByRole("list", { name: "Development history" }),
    ).toHaveTextContent(label);
  },
);
// Any older completion publishing items, offset or status breaks the explicit newest choice.
it.each([
  "late-success",
  "late-error",
  "pending-success",
  "failed-success",
  "pending-error",
  "failed-error",
])("keeps newest history ownership for %s", async (settlement) => {
  const older = deferred<unknown>(),
    newest = deferred<unknown>();
  let reads = 0;
  const page = (id: string, next: number | null) => ({
    items: [job({ binding: { ...BINDING, job_id: id }, state: "completed" })],
    next_offset: next,
  });
  const f = connected({
    "coding.list": () => {
      reads++;
      return reads === 1
        ? page("seed-job", 20)
        : reads === 2
          ? older.promise
          : reads === 3
            ? newest.promise
            : page("next-job", null);
    },
  });
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  const load = screen.getByRole("button", { name: "Load development history" });
  await userEvent.click(load);
  await userEvent.click(
    screen.getByRole("button", { name: "Next development history" }),
  );
  await userEvent.click(load);
  const history = screen.getByRole("list", { name: "Development history" });
  const status = screen.getByRole("status", { name: "Development status" });
  if (settlement.startsWith("late")) {
    newest.resolve(page("newest-job", 40));
    await waitFor(() => expect(history).toHaveTextContent("newest-job"));
  } else if (settlement.startsWith("failed")) {
    newest.reject(Error("latest unavailable"));
    await waitFor(() =>
      expect(status).toHaveTextContent(
        "History unavailable: latest unavailable",
      ),
    );
  }
  const before = { history: history.textContent, status: status.textContent };
  await act(async () => {
    if (settlement.endsWith("error")) older.reject(Error("older unavailable"));
    else older.resolve(page("stale-job", null));
  });
  expect(history.textContent).toBe(before.history);
  expect(status.textContent).toBe(before.status);
  if (settlement.startsWith("pending")) {
    newest.resolve(page("newest-job", 40));
    await waitFor(() => expect(history).toHaveTextContent("newest-job"));
  }
  await userEvent.click(
    screen.getByRole("button", { name: "Next development history" }),
  );
  expect(
    f.calls.filter((c) => c.method === "coding.list").map((c) => c.params),
  ).toEqual([
    { limit: 20, offset: 0 },
    { limit: 20, offset: 20 },
    { limit: 20, offset: 0 },
    { limit: 20, offset: settlement.startsWith("failed") ? 20 : 40 },
  ]);
  expect(
    f.calls.some((c) =>
      [
        "coding.start",
        "coding.cancel",
        "reasoning.start",
        "connection.test",
      ].includes(c.method),
    ),
  ).toBe(false);
});
it.each(
  ["revoke", "refresh", "api", "unmount"].flatMap((fence) =>
    [false, true].map((fails) => ({ fence, fails })),
  ),
)(
  "fences pending history after $fence (fails=$fails)",
  async ({ fence, fails }) => {
    const pending = deferred<unknown>();
    const f = connected({ "coding.list": () => pending.promise });
    const view = render(<Development api={f.api} />);
    await screen.findByText(pair.root_uri);
    await userEvent.click(
      screen.getByRole("button", { name: "Load development history" }),
    );
    if (fence === "revoke")
      f.emit({ version: 1, kind: "coding_cleared", pair_id: pair.pair_id });
    if (fence === "refresh")
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh editor status" }),
      );
    if (fence === "api") view.rerender(<Development api={connected().api} />);
    if (fence === "unmount") view.unmount();
    await act(async () => {
      if (fails) pending.reject(Error("stale failure"));
      else
        pending.resolve({
          items: [job({ binding: { ...BINDING, job_id: "stale-job" } })],
          next_offset: 40,
        });
    });
    expect(screen.queryByText(/stale failure/)).toBeNull();
    expect(screen.queryByText(/stale-job/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Next development history" }),
    ).toBeNull();
  },
);

it("keeps disclosed Send ready across informational history success and failure", async () => {
  const pending = deferred<unknown>();
  let reads = 0;
  const f = connected({
    "coding.list": () =>
      reads++ === 0 ? pending.promise : Promise.reject(Error("latest failed")),
  });
  render(<Development api={f.api} />);
  await screen.findByText(pair.root_uri);
  f.emit({ version: 1, kind: "coding_status", job: job() });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Development prompt" }),
    { target: { value: "Keep literal disclosure" } },
  );
  const send = screen.getByRole("button", { name: "Send request" });
  await waitFor(() => expect(send).toBeEnabled());
  await userEvent.click(
    screen.getByRole("button", { name: "Load development history" }),
  );
  expect(send).toBeEnabled();
  await act(async () => pending.resolve({ items: [], next_offset: 20 }));
  expect(send).toBeEnabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Load development history" }),
  );
  expect(
    await screen.findByText("History unavailable: latest failed"),
  ).toBeVisible();
  expect(send).toBeEnabled();
  expect(
    screen.getByRole("textbox", { name: "Development prompt" }),
  ).toHaveValue("Keep literal disclosure");
  expect(
    f.calls.some((c) =>
      [
        "coding.start",
        "coding.cancel",
        "reasoning.start",
        "connection.test",
      ].includes(c.method),
    ),
  ).toBe(false);
});
