// @vitest-environment jsdom
import { it, expect, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Development } from "../renderer/Development";
import { fixture, deferred } from "./renderer-fixture";
import { BINDING, HASH } from "./coding-fixtures";
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
  await screen.findByText(/Job status: cancelled/);
  start.resolve(job({ state: "proposing" }));
  f.emit({
    version: 1,
    kind: "coding_status",
    job: job({ state: "proposing" }),
  });
  expect(screen.getByText(/Job status: cancelled/)).toBeInTheDocument();
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
  expect(screen.getByText(/Job status: partial/)).toBeInTheDocument();
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
