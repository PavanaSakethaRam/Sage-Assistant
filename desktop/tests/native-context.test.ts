import { expect, it } from "vitest";
import { assertNativeElectronContext } from "../../e2e/native-context";

it("refuses native Electron launch in the Darwin command sandbox", () => {
  expect(() =>
    assertNativeElectronContext("darwin", { CODEX_SANDBOX: "seatbelt" }),
  ).toThrow(
    /native Electron tests require approved GUI-capable execution outside the command sandbox/i,
  );
});

it("leaves ordinary macOS and other platforms eligible for real startup checks", () => {
  const ordinaryMac = Object.freeze({ CODEX_SANDBOX: "other" });
  const macWithoutMarker = Object.freeze({});
  const otherPlatform = Object.freeze({ CODEX_SANDBOX: "seatbelt" });
  expect(() =>
    assertNativeElectronContext("darwin", ordinaryMac),
  ).not.toThrow();
  expect(() =>
    assertNativeElectronContext("darwin", macWithoutMarker),
  ).not.toThrow();
  expect(() =>
    assertNativeElectronContext("linux", otherPlatform),
  ).not.toThrow();
  expect(ordinaryMac.CODEX_SANDBOX).toBe("other");
  expect(otherPlatform.CODEX_SANDBOX).toBe("seatbelt");
});

import { selectedCase } from "../../scripts/test-vscode";
it("selects only implemented fixed editor cases", () => {
  expect(selectedCase(["--case", "create"])).toBe("create");
  expect(selectedCase(["--case", "replace"])).toBe("replace");
  expect(() => selectedCase(["--case", "create", "arbitrary"])).toThrow();
});

it("selects only fixed replacement scenarios in the owned harness", () => {
  for (const scenario of [
    "success",
    "participant",
    "human-save",
    "cancel-save",
    "disconnect-save",
    "expiry-save",
    "external-save",
    "auto-save",
  ])
    expect(selectedCase(["--case", "replace", "--scenario", scenario])).toBe(
      "replace",
    );
  for (const args of [
    ["--case", "replace", "--scenario", "arbitrary"],
    ["--case", "create", "--scenario", "success"],
    ["--case", "replace", "--other", "success"],
    ["--case", "replace", "--scenario", "success", "extra"],
  ])
    expect(() => selectedCase(args)).toThrow();
});

it("selects only bounded fixed test-runner scenarios and rejects mismatched flags", () => {
  expect(selectedCase(["--case", "test-runner"])).toBe("test-runner");
  for (const scenario of [
    "success",
    "nonzero",
    "timeout",
    "cancel",
    "overflow",
    "mutation",
    "inherited",
  ])
    expect(
      selectedCase(["--case", "test-runner", "--scenario", scenario]),
    ).toBe("test-runner");
  for (const args of [
    ["--case", "test-runner", "--scenario", "participant"],
    ["--case", "test-runner", "--other", "success"],
    ["--case", "test-runner", "--scenario", "success", "extra"],
  ])
    expect(() => selectedCase(args)).toThrow();
});
