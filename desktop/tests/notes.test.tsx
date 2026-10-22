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
