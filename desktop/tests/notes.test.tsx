// @vitest-environment jsdom
import { it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Notes } from "../renderer/Notes";
import { App } from "../renderer/App";
import { fixture, deferred, date, proposal } from "./renderer-fixture";
it("pages summaries then gets only the selected body and searches a bounded page", async () => {
  const { api, calls } = fixture({
    "notes.list": (p) => ({
      items: [
        {
          id: "note_1",
          title: "Saved one",
          created_at: date,
          updated_at: date,
          task_id: null,
        },
      ],
      next_offset: "offset" in p && p.offset === 0 ? 20 : null,
    }),
    "notes.search": () => ({ items: [], next_offset: null }),
  });
  render(<Notes api={api} />);
  await screen.findByRole("button", { name: "Saved one" });
  expect(calls.some((c) => c.method === "notes.get")).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Next notes" }));
  await waitFor(() =>
    expect(
      calls.some(
        (c) =>
          c.method === "notes.list" &&
          "offset" in c.params &&
          c.params.offset === 20,
      ),
    ).toBe(true),
  );
  await userEvent.click(screen.getByRole("button", { name: "Saved one" }));
  expect(
    (await screen.findByLabelText("Saved note literal body")).textContent,
  ).toBe(proposal.arguments.body);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Search saved notes" }),
    "exact search",
  );
  await userEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText("No saved notes in this page.");
  expect(calls.find((c) => c.method === "notes.search")?.params).toEqual({
    query: "exact search",
    limit: 20,
    offset: 0,
  });
  expect(screen.queryByLabelText("Saved note literal body")).toBeNull();
});
it("ignores stale selected-note details", async () => {
  const old = deferred<unknown>();
  const { api } = fixture({
    "notes.list": () => ({
      items: [
        {
          id: "old",
          title: "Old",
          created_at: date,
          updated_at: date,
          task_id: null,
        },
        {
          id: "new",
          title: "New",
          created_at: date,
          updated_at: date,
          task_id: null,
        },
      ],
      next_offset: null,
    }),
    "notes.get": (p) =>
      "note_id" in p && p.note_id === "old"
        ? old.promise
        : {
            id: "new",
            title: "New",
            body: "new body",
            created_at: date,
            updated_at: date,
            task_id: null,
          },
  });
  render(<Notes api={api} />);
  await userEvent.click(await screen.findByRole("button", { name: "Old" }));
  await userEvent.click(screen.getByRole("button", { name: "New" }));
  await screen.findByLabelText("Saved note literal body");
  old.resolve({
    id: "old",
    title: "Old",
    body: "stale body",
    created_at: date,
    updated_at: date,
    task_id: null,
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Saved note literal body")).toHaveTextContent(
      "new body",
    ),
  );
  expect(screen.queryByText("stale body")).toBeNull();
});
it("opens interrupted retained metadata without replay and recovers only through Review again", async () => {
  const { api, calls } = fixture({
    "tasks.list": () => ({
      items: [
        {
          id: "task_1",
          status: "interrupted",
          created_at: date,
          updated_at: date,
        },
      ],
      next_offset: null,
    }),
    "tasks.get": () => ({
      id: "task_1",
      status: "interrupted",
      created_at: date,
      updated_at: date,
      proposal,
      review_required: true,
      outcome: null,
    }),
  });
  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "task_1 · interrupted" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Open retained draft" }),
  );
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  expect(
    calls.some(
      (c) => c.method === "reasoning.start" || c.method === "notes.revise",
    ),
  ).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Review again" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled(),
  );
});
it("removes an open draft after task cancellation rather than retaining cancelled text", async () => {
  const { api } = fixture({
    "tasks.list": () => ({
      items: [
        { id: "task_1", status: "pending", created_at: date, updated_at: date },
      ],
      next_offset: null,
    }),
    "tasks.get": () => ({
      id: "task_1",
      status: "pending",
      created_at: date,
      updated_at: date,
      proposal,
      review_required: false,
      outcome: null,
    }),
    "tasks.cancel": () => ({
      task_id: "task_1",
      operation_id: null,
      status: "cancelled",
      note_id: null,
      diagnostic: null,
    }),
  });
  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "task_1 · pending" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Open retained draft" }),
  );
  expect(screen.getByLabelText("Literal note body")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
  await screen.findByText("Task cancelled");
  expect(screen.queryByLabelText("Literal note body")).toBeNull();
});

const secondProposal = {
  ...proposal,
  id: "proposal_2",
  task_id: "task_2",
  arguments: { title: "Second title", body: "Unrelated task two body" },
};
function taskFixture(overrides: Parameters<typeof fixture>[0] = {}) {
  return fixture({
    "tasks.list": () => ({
      items: ["task_1", "task_2"].map((id) => ({
        id,
        status: "pending",
        created_at: date,
        updated_at: date,
      })),
      next_offset: null,
    }),
    "tasks.get": (p) => ({
      id: "task_id" in p ? p.task_id : "task_1",
      status: "pending",
      created_at: date,
      updated_at: date,
      proposal:
        "task_id" in p && p.task_id === "task_2" ? secondProposal : proposal,
      review_required: false,
      outcome: null,
    }),
    "tasks.cancel": () => ({
      task_id: "task_1",
      operation_id: null,
      status: "cancelled",
      note_id: null,
      diagnostic: null,
    }),
    ...overrides,
  });
}
async function openFirstDraft() {
  await userEvent.click(
    await screen.findByRole("button", { name: "task_1 · pending" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Open retained draft" }),
  );
}
it("purges the retained snapshot after review cancellation so cancelled text cannot reopen", async () => {
  const { api } = taskFixture();
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Literal note body")).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Open retained draft" }),
  ).toBeNull();
  // A stale host-shaped snapshot must not revive text after the acknowledgement.
  await userEvent.click(
    await screen.findByRole("button", { name: "task_1 · cancelled" }),
  );
  await screen.findByText("No retained draft text available.");
  expect(
    screen.queryByRole("button", { name: "Open retained draft" }),
  ).toBeNull();
});
it("tracks a newly composed proposal identity for cancellation from task history", async () => {
  const { api } = taskFixture({
    "tasks.get": () => ({
      id: "task_1",
      status: "pending",
      created_at: date,
      updated_at: date,
      proposal: null,
      review_required: false,
      outcome: null,
    }),
  });
  render(<App api={api} />);
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "local draft",
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note body" }),
    "local body",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review note" }));
  await screen.findByLabelText("Literal note body");
  await userEvent.click(
    await screen.findByRole("button", { name: "task_1 · pending" }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: "Cancel task" }),
  );
  await screen.findByText("Task cancelled");
  expect(screen.queryByLabelText("Literal note body")).toBeNull();
});
it("applies matching cancellation cleanup after selecting another task without replacing that detail", async () => {
  const cancelled = deferred<unknown>();
  const { api } = taskFixture({ "tasks.cancel": () => cancelled.promise });
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
  await userEvent.click(
    screen.getByRole("button", { name: "task_2 · pending" }),
  );
  await screen.findByRole("heading", { name: "task_2 · pending" });
  cancelled.resolve({
    task_id: "task_1",
    operation_id: null,
    status: "cancelled",
    note_id: null,
    diagnostic: null,
  });
  await waitFor(() =>
    expect(screen.queryByLabelText("Literal note body")).toBeNull(),
  );
  expect(
    screen.getByRole("heading", { name: "task_2 · pending" }),
  ).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Open retained draft" }),
  );
  expect(screen.getByLabelText("Literal note body").textContent).toBe(
    "Unrelated task two body",
  );
});
it.each(["new local edits", "another retained draft"])(
  "preserves %s while an older task cancellation settles",
  async (newer) => {
    const cancelled = deferred<unknown>();
    const { api } = taskFixture({ "tasks.cancel": () => cancelled.promise });
    render(<App api={api} />);
    await openFirstDraft();
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
    await userEvent.click(
      screen.getByRole("button", { name: "task_2 · pending" }),
    );
    await screen.findByRole("heading", { name: "task_2 · pending" });
    if (newer === "new local edits") {
      await userEvent.click(screen.getByRole("button", { name: "New note" }));
      await userEvent.type(
        screen.getByRole("textbox", { name: "Note title" }),
        "Keep newer local title",
      );
    } else
      await userEvent.click(
        screen.getByRole("button", { name: "Open retained draft" }),
      );
    cancelled.resolve({
      task_id: "task_1",
      operation_id: null,
      status: "cancelled",
      note_id: null,
      diagnostic: null,
    });
    await screen.findByRole("button", { name: "task_1 · cancelled" });
    expect(
      screen.getByRole("heading", { name: "task_2 · pending" }),
    ).toBeInTheDocument();
    if (newer === "new local edits")
      expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
        "Keep newer local title",
      );
    else
      expect(screen.getByLabelText("Literal note body").textContent).toBe(
        "Unrelated task two body",
      );
  },
);
it("fences an outstanding task detail that resolves after review cancellation", async () => {
  const stale = deferred<unknown>();
  let reads = 0;
  const { api } = taskFixture({
    "tasks.get": () =>
      reads++ === 0
        ? {
            id: "task_1",
            status: "pending",
            created_at: date,
            updated_at: date,
            proposal,
            review_required: false,
            outcome: null,
          }
        : stale.promise,
  });
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(
    screen.getByRole("button", { name: "task_1 · pending" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Literal note body")).toBeNull(),
  );
  stale.resolve({
    id: "task_1",
    status: "pending",
    created_at: date,
    updated_at: date,
    proposal,
    review_required: false,
    outcome: null,
  });
  await screen.findByRole("heading", { name: "task_1 · cancelled" });
  expect(
    screen.queryByRole("button", { name: "Open retained draft" }),
  ).toBeNull();
  expect(screen.queryByText(proposal.arguments.body)).toBeNull();
});
it("purges an old review cancellation even after its editor is replaced, preserving newer edits", async () => {
  const cancelled = deferred<unknown>();
  const { api } = taskFixture({ "notes.decide": () => cancelled.promise });
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "Keep replacement",
  );
  cancelled.resolve({
    task_id: "task_1",
    operation_id: null,
    status: "cancelled",
    note_id: null,
    diagnostic: null,
  });
  await screen.findByRole("button", { name: "task_1 · cancelled" });
  expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
    "Keep replacement",
  );
  expect(
    screen.queryByRole("button", { name: "Open retained draft" }),
  ).toBeNull();
});
it("does not invalidate newer unrelated inference when an older task cancellation settles", async () => {
  const cancelled = deferred<unknown>(),
    response = deferred<unknown>();
  const { api } = taskFixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "tasks.cancel": () => cancelled.promise,
    "reasoning.start": () => response.promise,
  });
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(screen.getByRole("button", { name: "Cancel task" }));
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "Newer context",
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "Unrelated new request",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  cancelled.resolve({
    task_id: "task_1",
    operation_id: null,
    status: "cancelled",
    note_id: null,
    diagnostic: null,
  });
  await screen.findByRole("button", { name: "task_1 · cancelled" });
  response.resolve({
    status: "completed",
    task_id: "task_2",
    text: "New response",
    proposal: secondProposal,
    usage: null,
  });
  expect((await screen.findByLabelText("Literal note body")).textContent).toBe(
    "Unrelated task two body",
  );
});

const savedOutcome = {
  task_id: "task_1",
  operation_id: "op_1",
  status: "succeeded",
  note_id: "note_1",
  diagnostic: null,
};
it.each(["new local edits", "another retained draft"])(
  "acknowledges a committed save after replacement by %s",
  async (replacement) => {
    const decision = deferred<unknown>();
    let committed = false;
    const { api } = taskFixture({
      "notes.decide": () => decision.promise,
      "notes.list": () => ({
        items: committed
          ? [
              {
                id: "note_1",
                title: "Committed note",
                task_id: "task_1",
                created_at: date,
                updated_at: date,
              },
            ]
          : [],
        next_offset: null,
      }),
    });
    render(<App api={api} />);
    await openFirstDraft();
    await userEvent.click(screen.getByRole("button", { name: "Save note" }));
    if (replacement === "new local edits") {
      await userEvent.click(screen.getByRole("button", { name: "New note" }));
      await userEvent.type(
        screen.getByRole("textbox", { name: "Note title" }),
        "Keep replacement",
      );
      await userEvent.type(
        screen.getByRole("textbox", { name: "Note body" }),
        "Keep replacement body",
      );
    } else {
      await userEvent.click(
        screen.getByRole("button", { name: "task_2 · pending" }),
      );
      await screen.findByRole("heading", { name: "task_2 · pending" });
      await userEvent.click(
        screen.getByRole("button", { name: "Open retained draft" }),
      );
    }
    committed = true;
    decision.resolve(savedOutcome);
    await screen.findByRole("button", { name: "Committed note" });
    await screen.findByRole("button", { name: "task_1 · succeeded" });
    expect(screen.getByLabelText("Saved note receipt")).toHaveTextContent(
      "saved note note_1",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "task_2 · pending" }),
    );
    await screen.findByRole("heading", { name: "task_2 · pending" });
    expect(screen.getByLabelText("Saved note receipt")).toHaveTextContent(
      "saved note note_1",
    );
    if (replacement === "new local edits") {
      expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
        "Keep replacement",
      );
      expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(
        "Keep replacement body",
      );
    } else
      expect(screen.getByLabelText("Literal note body").textContent).toBe(
        "Unrelated task two body",
      );
  },
);
it("reconciles the selected retained task after save without reopening consumed review", async () => {
  const { api } = taskFixture();
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByRole("heading", { name: "task_1 · succeeded" });
  expect(
    screen.queryByRole("button", { name: "Open retained draft" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
  expect(await screen.findByLabelText("Saved body")).toHaveTextContent(
    "Full body",
  );
  expect(
    screen.getByText("Recorded outcome: succeeded · saved note note_1"),
  ).toBeInTheDocument();
});
it("fences an older pending task detail after successful save", async () => {
  const stale = deferred<unknown>();
  let reads = 0;
  const pending = {
    id: "task_1",
    status: "pending",
    created_at: date,
    updated_at: date,
    proposal,
    review_required: false,
    outcome: null,
  };
  const { api } = taskFixture({
    "tasks.get": () => (reads++ === 0 ? pending : stale.promise),
  });
  render(<App api={api} />);
  await openFirstDraft();
  await userEvent.click(
    screen.getByRole("button", { name: "task_1 · pending" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByLabelText("Saved body");
  stale.resolve(pending);
  await screen.findByRole("heading", { name: "task_1 · succeeded" });
  expect(
    screen.queryByRole("button", { name: "Open retained draft" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
});
