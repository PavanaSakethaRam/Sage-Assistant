// @vitest-environment jsdom
import { it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../renderer/App";
import { fixture, deferred } from "./renderer-fixture";
it("shows all requested choices without unsupported key collection or fake local readiness", async () => {
  const { api, calls } = fixture();
  render(<App api={api} />);
  await screen.findByRole("radio", { name: "Local AI only" });
  expect(
    screen.getByRole("radio", { name: "Connect an assistant" }),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: "Use an API key" }));
  expect(
    await screen.findByText(/API adapters are unavailable/),
  ).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: /API key/i })).toBeNull();
  expect(calls.some((c) => c.method === "connection.test")).toBe(false);
  await userEvent.click(
    screen.getByRole("radio", { name: "Connect an assistant" }),
  );
  expect(
    screen.getByRole("option", { name: /Codex.*unavailable/i }),
  ).toBeDisabled();
  expect(
    screen.getByRole("option", { name: /OpenCode.*unavailable/i }),
  ).toBeDisabled();
  expect(
    screen.getByRole("option", { name: /Claude.*unavailable/i }),
  ).toBeDisabled();
  expect(screen.getByText(/VSCode sign-in/)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Choose Copilot account" }),
  );
  expect(
    await screen.findByText(/Account selected.*not model readiness/),
  ).toBeInTheDocument();
  expect(calls.filter((c) => c.method === "connection.test")).toHaveLength(0);
  expect(screen.getByText(/quota/)).toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "Test connection" }),
  );
  expect(calls.filter((c) => c.method === "connection.test")).toHaveLength(1);
});
it("waits for mode authority and reconciles failure while preserving local edits", async () => {
  const write = deferred<unknown>();
  const { api } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "settings.update": () => write.promise,
  });
  render(<App api={api} />);
  await screen.findByRole("button", { name: "Choose Copilot account" });
  await userEvent.click(screen.getByRole("button", { name: "New note" }));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Note title" }),
    "keep me",
  );
  await userEvent.click(screen.getByRole("radio", { name: "Local AI only" }));
  expect(
    screen.getByRole("radio", { name: "Connect an assistant" }),
  ).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Choose Copilot account" }),
  ).toBeDisabled();
  write.reject(Error("failure"));
  await screen.findByText(/Mode change failed/);
  await waitFor(() =>
    expect(
      screen.getByRole("radio", { name: "Connect an assistant" }),
    ).toBeChecked(),
  );
  expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue(
    "keep me",
  );
});
it("shows account unavailability without falling back to credentials or automatic tests", async () => {
  const { api, calls } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "copilot.chooseAccount": () => ({ status: "unavailable" }),
  });
  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Choose Copilot account" }),
  );
  await screen.findByText("Connection: unavailable");
  expect(
    calls
      .filter((c) => c.method === "copilot.chooseAccount")
      .map((c) => c.params),
  ).toEqual([{}]);
  expect(
    calls.some(
      (c) => c.method === "connection.test" || c.method === "reasoning.start",
    ),
  ).toBe(false);
  expect(screen.getByRole("button", { name: "New note" })).toBeEnabled();
});
it("leaves mode unknown when both a mode write and reconciliation fail", async () => {
  let reads = 0;
  const { api } = fixture({
    "settings.get": () => {
      if (reads++ === 0)
        return { ai_mode: "assistant", reasoning_backend: "copilot" };
      throw Error("unavailable");
    },
    "settings.update": () => {
      throw Error("timeout");
    },
  });
  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("radio", { name: "Local AI only" }),
  );
  await screen.findByText(/actual mode unknown/);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(screen.getByText("Actual mode: unknown")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "New note" })).toBeEnabled();
});
it("holds setup controls during readiness reconciliation and clears old ready evidence on refresh failure", async () => {
  const readiness = deferred<unknown>();
  let reads = 0;
  const { api } = fixture({
    "settings.get": () => ({
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
    "readiness.list": () =>
      reads++ === 0
        ? {
            items: [
              {
                provider: "copilot",
                status: "ready",
                evidence: ["old_ready_evidence"],
                version: "1.0.102",
                destination: "GitHub Copilot cloud",
                explanation: "Previously tested",
              },
            ],
          }
        : readiness.promise,
  });
  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("radio", { name: "Local AI only" }),
  );
  expect(
    screen.getByRole("radio", { name: "Connect an assistant" }),
  ).toBeDisabled();
  readiness.reject(Error("timeout"));
  await screen.findByText(/readiness unavailable: timeout/i);
  expect(screen.queryByText(/old_ready_evidence/)).toBeNull();
  expect(screen.getByRole("radio", { name: "Local AI only" })).toBeChecked();
  expect(
    screen.getByRole("radio", { name: "Connect an assistant" }),
  ).toBeEnabled();
});
it("does not start a second settings load while the initial request is pending", async () => {
  const settings = deferred<unknown>();
  const { api } = fixture({ "settings.get": () => settings.promise });
  render(<App api={api} />);
  expect(screen.queryByRole("button", { name: "Reload settings" })).toBeNull();
  settings.resolve({ ai_mode: "local", reasoning_backend: null });
  await screen.findByText("Actual mode: local");
});
it("serializes explicit reload recovery and refreshes prerequisites", async () => {
  const pending = deferred<unknown>();
  let reads = 0;
  const { api, calls } = fixture({
    "settings.get": () => {
      if (reads++ === 0) throw Error("timeout");
      return pending.promise;
    },
  });
  render(<App api={api} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Reload settings" }),
  );
  expect(screen.queryByRole("button", { name: "Reload settings" })).toBeNull();
  pending.resolve({ ai_mode: "local", reasoning_backend: null });
  await screen.findByText("Actual mode: local");
  await waitFor(() =>
    expect(calls.filter((c) => c.method === "readiness.list")).toHaveLength(2),
  );
});
