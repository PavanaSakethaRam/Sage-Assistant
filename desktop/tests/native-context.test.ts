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
