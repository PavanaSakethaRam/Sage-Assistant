import { expect, it } from "vitest";
import { isolatedChildEnv } from "../main/child-env";

const blocked = [
  "PATH",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
] as const;

it("fills every Windows libuv required slot without ambient identity or lookup values", () => {
  const parent: NodeJS.ProcessEnv = Object.fromEntries(
    blocked.map((name) => [name.toLowerCase(), `ambient-${name}`]),
  );
  Object.assign(parent, {
    systemroot: "C:\\Windows",
    windir: "C:\\Windows",
    sYsTeMdRiVe: "C:",
    temp: "C:\\ambient-temp",
    GH_TOKEN: "synthetic-secret",
  });
  const env = isolatedChildEnv(
    {
      LANG: "C.UTF-8",
      TMPDIR: "C:\\owned\\tmp",
      TMP: "C:\\owned\\tmp",
      TEMP: "C:\\owned\\tmp",
      PATH: "bad-owned-path",
      Path: "another-bad-owned-path",
    },
    "win32",
    parent,
  );
  for (const name of blocked) expect(env[name]).toBe("");
  expect(env.TEMP).toBe("C:\\owned\\tmp");
  expect(env.TMP).toBe("C:\\owned\\tmp");
  expect(env.TMPDIR).toBe("C:\\owned\\tmp");
  expect(env.SystemRoot).toBe("C:\\Windows");
  expect(env.WINDIR).toBe("C:\\Windows");
  expect(env.SystemDrive).toBe("C:");
  expect(env.GH_TOKEN).toBeUndefined();
  const names = Object.keys(env).map((name) => name.toUpperCase());
  expect(new Set(names).size).toBe(names.length);
});

it("keeps Unix blocked slots omitted and only existing OS-root carryover", () => {
  const env = isolatedChildEnv(
    { LANG: "C.UTF-8", TEMP: "/owned/tmp" },
    "darwin",
    { PATH: "/ambient", USERNAME: "ambient", SystemRoot: "/synthetic-os" },
  );
  for (const name of blocked) expect(env[name]).toBeUndefined();
  expect(env.SystemRoot).toBe("/synthetic-os");
  expect(env.WINDIR).toBeUndefined();
  expect(env.SystemDrive).toBeUndefined();
});

it("rejects conflicting case aliases for OS essentials before reading their values", () => {
  expect(() =>
    isolatedChildEnv({ TEMP: "C:\\owned" }, "win32", {
      SystemRoot: "C:\\Windows",
      SYSTEMROOT: "D:\\other",
    }),
  ).toThrow("Ambiguous OS environment key");
});

import { nativeEnvironmentProof } from "../../extension/test/integration/test-runner";
it("keeps supplied maps separate from the sealed actual native additions", () => {
  const supplied = {
    PATH: "",
    TEMP: "/owned/tmp",
    TMP: "/owned/tmp",
    TMPDIR: "/owned/tmp",
  };
  const actual = {
    ...supplied,
    NODE_TEST_WORKER_ID: "1",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
  };
  expect(
    nativeEnvironmentProof(supplied, actual, "darwin", 501, 501).accepted,
  ).toBe(true);
  for (const mutation of [
    { __CF_USER_TEXT_ENCODING: "0x000000001:0x0:0x0" },
    { __CF_USER_TEXT_ENCODING: "0x1F4:0x0:0x0" },
    { __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0\n" },
    { __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0 " },
    { __CF_USER_TEXT_ENCODING: "0x1F5:0x0" },
    { EXTRA: "unknown" },
    { Path: "" },
    { PATH: "fallback" },
    { NODE_TEST_WORKER_ID: "2" },
  ])
    expect(
      nativeEnvironmentProof(
        supplied,
        { ...actual, ...mutation },
        "darwin",
        501,
        501,
      ).accepted,
    ).toBe(false);
  expect(
    nativeEnvironmentProof(supplied, actual, "darwin", 501, 502).accepted,
  ).toBe(false);
});
it("Windows constructor blanks prevent fallback but a map double never establishes native readiness", () => {
  const supplied = isolatedChildEnv(
    {
      HOME: "",
      TEMP: "C:\\owned\\tmp",
      TMP: "C:\\owned\\tmp",
      TMPDIR: "C:\\owned\\tmp",
    },
    "win32",
    {},
  ) as Record<string, string>;
  expect(
    nativeEnvironmentProof(
      supplied,
      { ...supplied, NODE_TEST_WORKER_ID: "1" },
      "win32",
      undefined,
      undefined,
    ).accepted,
  ).toBe(true);
  expect(
    nativeEnvironmentProof(
      supplied,
      { ...supplied, NODE_TEST_WORKER_ID: "1", USERPROFILE: "C:\\ambient" },
      "win32",
      undefined,
      undefined,
    ).accepted,
  ).toBe(false);
});
