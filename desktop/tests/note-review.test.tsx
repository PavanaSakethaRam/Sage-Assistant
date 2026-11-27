// @vitest-environment jsdom
import { it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NoteReview } from "../renderer/NoteReview";
import { fixture, proposal } from "./renderer-fixture";
it("reviews full literal content then saves exact identity and displays the persisted note", async () => {
  const { api, calls } = fixture();
  render(<NoteReview api={api} proposal={proposal} />);
  expect(screen.getByLabelText("Literal note body").textContent).toBe(
    proposal.arguments.body,
  );
  const save = screen.getByRole("button", { name: "Save note" });
  save.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("Saved note");
  expect(calls.find((c) => c.method === "notes.decide")?.params).toEqual({
    proposal_id: "proposal_1",
    revision: 1,
    decision: "save",
  });
  expect(screen.getByLabelText("Saved body").textContent).toBe(
    proposal.arguments.body,
  );
  expect(screen.getByLabelText("Saved title").textContent).toBe(
    proposal.arguments.title,
  );
});
it("edits create a new revision before keyboard cancellation", async () => {
  const { api, calls } = fixture();
  render(<NoteReview api={api} proposal={proposal} />);
  await userEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note body" }),
    " updated",
  );
  expect(screen.queryByRole("button", { name: "Save note" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Review note" }));
  await waitFor(() =>
    expect(calls.some((c) => c.method === "notes.revise")).toBe(true),
  );
  const cancel = screen.getByRole("button", { name: "Cancel draft" });
  cancel.focus();
  await userEvent.keyboard(" ");
  await screen.findByText("Draft cancelled");
  expect(calls.find((c) => c.method === "notes.decide")?.params).toEqual({
    proposal_id: "proposal_1",
    revision: 2,
    decision: "cancel",
  });
  expect(screen.queryByLabelText("Literal note body")).toBeNull();
});
it("accepts 200 astral code points from real editing, rejects 201 and preserves BOM and full bodies", async () => {
  const { api, calls } = fixture();
  render(<NoteReview api={api} />);
  const title = screen.getByRole("textbox", { name: "Note title" });
  await userEvent.click(title);
  await userEvent.paste("😀".repeat(200));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note body" }),
    "\uFEFF\n\t" + "a".repeat(20),
  );
  expect(screen.getByRole("button", { name: "Review note" })).toBeEnabled();
  await userEvent.paste("😀"); // focus remains body; put extra astral title explicitly
  await userEvent.click(title);
  await userEvent.paste("😀");
  expect(title).toHaveValue("😀".repeat(201));
  expect(screen.getByRole("button", { name: "Review note" })).toBeDisabled();
  expect(calls).toHaveLength(0);
});
it("requires explicit Review again for retained drafts and never renews a stale Save", async () => {
  const { api, calls } = fixture({
    "notes.decide": () => ({
      task_id: "task_1",
      operation_id: null,
      status: "rejected",
      note_id: null,
      diagnostic: "stale_revision",
    }),
  });
  render(<NoteReview api={api} proposal={proposal} reviewRequired />);
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Review again" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save note" })).toBeEnabled(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByText(/stale_revision/);
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  expect(calls.filter((c) => c.method === "notes.revise")).toHaveLength(1);
});
it("preserves edits when revision recovery fails and does not revive missing draft text", async () => {
  const { api, calls } = fixture({
    "notes.revise": () => {
      throw Error("not_found");
    },
  });
  render(<NoteReview api={api} proposal={proposal} reviewRequired />);
  await userEvent.click(screen.getByRole("button", { name: "Edit draft" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note body" }),
    " keep",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review note" }));
  await screen.findByText(/Review failed.*not_found/);
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(
    proposal.arguments.body + " keep",
  );
  expect(screen.queryByRole("button", { name: "Save note" })).toBeNull();
  expect(calls.some((c) => c.method === "notes.decide")).toBe(false);
});
it("reviews all 100000 literal body code points including media syntax and never truncates", async () => {
  const body =
    "\uFEFF\n\t![track](https://example.invalid/pixel)" + "😀".repeat(99958);
  // 42 literal prefix code points + 99,958 astral symbols = 100,000.
  expect([...body]).toHaveLength(100000);
  const literal = { title: "\uFEFF", body };
  const { api, calls } = fixture({
    "notes.propose": (p) => ({ ...proposal, arguments: p }),
  });
  render(<NoteReview api={api} />);
  await userEvent.click(screen.getByRole("textbox", { name: "Note title" }));
  await userEvent.paste(literal.title);
  await userEvent.click(screen.getByRole("textbox", { name: "Note body" }));
  await userEvent.paste(body);
  expect(screen.getByRole("button", { name: "Review note" })).toBeEnabled();
  await userEvent.click(screen.getByRole("button", { name: "Review note" }));
  expect((await screen.findByLabelText("Literal note body")).textContent).toBe(
    body,
  );
  expect(calls.find((c) => c.method === "notes.propose")?.params).toEqual(
    literal,
  );
});
it("rejects overlong bodies, blank Unicode whitespace and invalid controls while accepting combining characters", async () => {
  const { api } = fixture();
  render(<NoteReview api={api} />);
  const title = screen.getByRole("textbox", { name: "Note title" }),
    body = screen.getByRole("textbox", { name: "Note body" });
  await userEvent.click(title);
  await userEvent.paste("\u2003");
  await userEvent.click(body);
  await userEvent.paste("text");
  expect(screen.getByRole("button", { name: "Review note" })).toBeDisabled();
  await userEvent.clear(title);
  await userEvent.paste("e\u0301".repeat(100));
  expect(screen.getByRole("button", { name: "Review note" })).toBeEnabled();
  await userEvent.click(body);
  await userEvent.clear(body);
  await userEvent.paste("a".repeat(100001));
  expect(screen.getByRole("button", { name: "Review note" })).toBeDisabled();
  await userEvent.clear(body);
  await userEvent.paste("a\u0000b");
  expect(screen.getByRole("button", { name: "Review note" })).toBeDisabled();
});
it("can discard a local composition before proposing without calling the host", async () => {
  const { api, calls } = fixture();
  render(<NoteReview api={api} />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "private unsaved",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Discard local edits" }),
  );
  expect(screen.queryByRole("textbox", { name: "Note title" })).toBeNull();
  expect(calls).toHaveLength(0);
  expect(
    screen.getByRole("status", { name: "Note review status" }),
  ).toHaveTextContent("Local edits discarded");
});
it("does not claim cancellation when the host rejects the decision", async () => {
  const { api } = fixture({
    "notes.decide": () => ({
      task_id: "task_1",
      operation_id: null,
      status: "rejected",
      note_id: null,
      diagnostic: null,
    }),
  });
  render(<NoteReview api={api} proposal={proposal} />);
  await userEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
  await screen.findByText("rejected");
  expect(screen.getByLabelText("Literal note body").textContent).toBe(
    proposal.arguments.body,
  );
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
});
it("displays the actual saved record and never infers persistence from the draft", async () => {
  const { api } = fixture({
    "notes.get": () => ({
      id: "note_1",
      title: "Persisted  title",
      body: "Persisted\n\tbody",
      created_at: "2026-10-22T12:00:00Z",
      updated_at: "2026-10-22T12:00:00Z",
      task_id: "task_1",
    }),
  });
  render(<NoteReview api={api} proposal={proposal} />);
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByText("Saved note");
  expect(screen.getByLabelText("Saved title").textContent).toBe(
    "Persisted  title",
  );
  expect(screen.getByLabelText("Saved body").textContent).toBe(
    "Persisted\n\tbody",
  );
});
it("reports failed saved-record recovery with the committed ID without pretending a draft is the saved body", async () => {
  const { api } = fixture({
    "notes.get": () => {
      throw Error("timeout");
    },
  });
  render(<NoteReview api={api} proposal={proposal} />);
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByText(
    /Saved as note_1; loading saved note failed: timeout/,
  );
  expect(screen.queryByLabelText("Saved body")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save note" })).toBeNull();
});
it("retains the full draft after a failed Save and requires new review", async () => {
  const { api, calls } = fixture({
    "notes.decide": () => {
      throw Error("timeout");
    },
  });
  render(<NoteReview api={api} proposal={proposal} />);
  await userEvent.click(screen.getByRole("button", { name: "Save note" }));
  await screen.findByText(/Decision failed: timeout/);
  expect(screen.getByLabelText("Literal note body").textContent).toBe(
    proposal.arguments.body,
  );
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  expect(calls.some((c) => c.method === "notes.revise")).toBe(false);
});
