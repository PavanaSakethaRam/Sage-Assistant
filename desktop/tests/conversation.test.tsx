// @vitest-environment jsdom
import { it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../renderer/App";
import { fixture, deferred, proposal } from "./renderer-fixture";
it("local notes work without a model and provider failure leaves note controls usable", async () => {
  const { api, calls } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "reasoning.start": () => ({
      status: "unavailable",
      code: "inference_unavailable",
    }),
  });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Send message" });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "hello",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(/inference_unavailable/);
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "local",
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note body" }),
    "body",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review note" }));
  await screen.findByRole("button", { name: "Save note" });
  expect(calls.filter((c) => c.method === "notes.propose")).toHaveLength(1);
});
it("cancels pending inference and ignores its late proposal without wiping newer local edits", async () => {
  const result = deferred<unknown>();
  const { api, calls } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "reasoning.start": () => result.promise,
  });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Send message" });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "hello",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  expect(
    screen.getByRole("status", { name: "Conversation status" }),
  ).toHaveTextContent("Pending");
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel response" }),
  );
  await screen.findByText("Response cancelled");
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "newer",
  );
  result.resolve({
    status: "completed",
    task_id: "task_1",
    text: "late",
    proposal,
    usage: null,
  });
  await waitFor(() =>
    expect(calls.some((c) => c.method === "reasoning.cancel")).toBe(true),
  );
  expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
    "newer",
  );
  expect(screen.queryByText("late")).toBeNull();
});
it("keeps newer local edits when a completed response includes a stale proposal", async () => {
  const result = deferred<unknown>();
  const { api } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "reasoning.start": () => result.promise,
  });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Send message" });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "draft",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "newer local",
  );
  result.resolve({
    status: "completed",
    task_id: "task_1",
    text: "Completed response",
    proposal,
    usage: null,
  });
  await screen.findByText("Completed response", { selector: "p" });
  expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
    "newer local",
  );
  expect(
    screen.getByRole("status", { name: "Task history status" }),
  ).toHaveTextContent(/ignored/);
});
it("enforces code point message/context limits without native UTF16 truncation", async () => {
  const { api } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
  });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Send message" });
  const text = screen.getByRole("textbox", { name: "Message" }),
    context = screen.getByRole("textbox", { name: "Attached context" });
  await userEvent.click(text);
  await userEvent.paste("😀".repeat(32000));
  await userEvent.click(context);
  await userEvent.paste("😀".repeat(64000));
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  await userEvent.paste("😀");
  expect(context).toHaveValue("😀".repeat(64001));
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  await userEvent.clear(context);
  await userEvent.click(text);
  await userEvent.paste("a");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
});
it("does not let a late local proposal replace a fresh editor", async () => {
  const result = deferred<unknown>();
  const { api } = fixture({ "notes.propose": () => result.promise });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "New note" });
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "old",
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note body" }),
    "old body",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review note" }));
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "new",
  );
  result.resolve(proposal);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
      "new",
    ),
  );
  expect(screen.queryByLabelText("Literal note body")).toBeNull();
});
it("does not let an older cancellation status overwrite a new pending response", async () => {
  const cancellation = deferred<unknown>();
  const { api, calls } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "reasoning.start": () => new Promise(() => {}),
    "reasoning.cancel": () => cancellation.promise,
  });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Send message" });
  await userEvent.type(
    screen.getByRole("textbox", { name: "Message" }),
    "first",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Cancel response" }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  cancellation.resolve({ status: "unknown_request" });
  await waitFor(() =>
    expect(calls.filter((c) => c.method === "reasoning.start")).toHaveLength(2),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    screen.getByRole("status", { name: "Conversation status" }),
  ).toHaveTextContent(/^Pending$/);
});
