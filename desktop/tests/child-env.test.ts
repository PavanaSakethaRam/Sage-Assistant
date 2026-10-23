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
