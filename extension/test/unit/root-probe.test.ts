import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseRootProbe,
  validateRootSpelling,
  probeRoot,
} from "../../src/root-probe";
it("accepts only the fixed closed ASCII local identity record", () => {
  expect(parseRootProbe("SAGE_ROOT_V1 darwin 1 2\n", "darwin")).toBe(
    "darwin-1-2",
  );
  for (const text of [
    "SAGE_ROOT_V2 darwin 1 2\n",
    "SAGE_ROOT_V1 win32 1 2\n",
    "SAGE_ROOT_V1 darwin 1 2\nextra",
    "SAGE_ROOT_V1 darwin 01 2\n",
    "SAGE_ROOT_V1 darwin 1 2\r\n",
    "SAGE_ROOT_V1 darwin 1 2é\n",
  ])
    expect(() => parseRootProbe(text, "darwin")).toThrow();
});
it("refuses ambiguous, network, control, invalid Unicode and oversized selected roots", () => {
  expect(
    validateRootSpelling("/Users/owner/Project", "darwin"),
  ).toBeUndefined();
  expect(
    validateRootSpelling("C:\\Users\\owner\\Project", "win32"),
  ).toBeUndefined();
  for (const p of [
    "relative",
    "//server/share",
    "/a/../b",
    "/a/./b",
    "/a//b",
    "/a/",
    "/a\n",
    "/a\ud800",
    "/" + "x".repeat(16384),
  ])
    expect(() => validateRootSpelling(p, "darwin")).toThrow();
  for (const p of [
    "C:root",
    "\\\\server\\share",
    "\\\\?\\C:\\a",
    "C:\\a.",
    "C:\\a ",
    "C:\\PROGRA~1",
    "c:\\folder",
    "C:\\a:stream",
    "C:\\a\\..\\b",
  ])
    expect(() => validateRootSpelling(p, "win32")).toThrow();
});

import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
  chmod,
  copyFile,
  readdir,
  readFile,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
const mockSpawn = vi.hoisted(() => vi.fn());
const nativeDouble = vi.hoisted(() => ({
  run: undefined as undefined | ((...args: unknown[]) => unknown),
  files: new Map<string, Buffer>(),
  directories: new Set<string>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
  spawnSync: (...args: unknown[]) => {
    if (nativeDouble.run) return nativeDouble.run(...args);
    return actualSpawnSync(...(args as Parameters<typeof actualSpawnSync>));
  },
}));
const { spawnSync: actualSpawnSync } =
  await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      const bytes = nativeDouble.files.get(String(args[0]));
      return bytes
        ? Promise.resolve(args[1] === "utf8" ? bytes.toString() : bytes)
        : actual.readFile(...args);
    },
    stat: (...args: Parameters<typeof actual.stat>) =>
      nativeDouble.files.has(String(args[0])) ||
      nativeDouble.directories.has(String(args[0]))
        ? Promise.resolve({
            isFile: () => nativeDouble.files.has(String(args[0])),
            isDirectory: () => nativeDouble.directories.has(String(args[0])),
            isSymbolicLink: () => false,
            size: nativeDouble.files.get(String(args[0]))?.length ?? 0,
          })
        : actual.stat(...args),
    lstat: (...args: Parameters<typeof actual.lstat>) =>
      nativeDouble.files.has(String(args[0]))
        ? Promise.resolve({
            isFile: () => true,
            isSymbolicLink: () => false,
            size: nativeDouble.files.get(String(args[0]))!.length,
          })
        : actual.lstat(...args),
  };
});
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildRootProbe,
  reportNativeCoverage,
} from "../../../scripts/build-root-probe";
import { isolatedChildEnv } from "../../../desktop/main/child-env";
const nativeHost =
  (process.platform === "darwin" && process.arch === "arm64") ||
  (process.platform === "win32" && process.arch === "x64");
it.runIf(nativeHost)(
  "builds instrumented helpers in the canonical cache under an owned root",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sage-native-cache-")),
    );
    try {
      await mkdir(join(root, "scripts"));
      await mkdir(join(root, "extension/native"), { recursive: true });
      for (const name of [
        "scripts/build-root-probe.ts",
        "extension/native/root-probe.c",
      ])
        await copyFile(join(process.cwd(), name), join(root, name));
      const built = spawnSync(
        process.execPath,
        [join(root, "scripts/build-root-probe.ts"), "--coverage"],
        { cwd: root, shell: false, encoding: "utf8", timeout: 30000 },
      );
      expect(built.status, built.stderr).toBe(0);
      expect(await readdir(join(root, ".cache"))).toEqual(["native-coverage"]);
      const provenance = JSON.parse(
        await readFile(
          join(root, ".cache/native-coverage/provenance.json"),
          "utf8",
        ),
      );
      expect(provenance.coverage).toBe(true);
      expect(provenance.flags).toContain("-fcoverage-mapping");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.runIf(nativeHost)(
  "exercises the actual fixed native helper on local folders and refuses aliases/invalid bytes",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sage-root-native-")),
    );
    try {
      const coverage = process.env.SAGE_NATIVE_COVERAGE === "1",
        probe = await buildRootProbe(coverage);
      let sequence = 0;
      const invoke = (input: Buffer | string, args = ["--check-root-v1"]) =>
        spawnSync(probe.path, args, {
          shell: false,
          input,
          env: isolatedChildEnv(
            {
              PATH: "",
              TEMP: root,
              TMP: root,
              TMPDIR: root,
              ...(process.platform === "win32" ? { HOME: "" } : {}),
              ...(coverage
                ? {
                    LLVM_PROFILE_FILE: join(
                      process.cwd(),
                      `.cache/native-coverage/run-${process.pid}-${sequence++}.profraw`,
                    ),
                  }
                : {}),
            },
            process.platform,
            process.platform === "win32" ? process.env : {},
          ),
          timeout: 2000,
          maxBuffer: 2048,
        });
      if (process.platform === "win32") {
        const env = isolatedChildEnv(
          { PATH: "", HOME: "", TEMP: root, TMP: root, TMPDIR: root },
          "win32",
          process.env,
        );
        expect(env.SystemRoot).toMatch(/^[A-Za-z]:\\[^\u0000-\u001f]+$/u);
        expect(env.WINDIR).toBe(env.SystemRoot);
        expect(env.SystemDrive).toMatch(/^[A-Za-z]:$/u);
        for (const name of [
          "HOME",
          "HOMEDRIVE",
          "HOMEPATH",
          "LOGONSERVER",
          "USERDOMAIN",
          "USERNAME",
          "USERPROFILE",
          "PATH",
        ])
          expect(env[name]).toBe("");
      }
      const valid = invoke(root);
      expect(valid.status).toBe(0);
      expect(valid.stderr.length).toBe(0);
      expect(parseRootProbe(valid.stdout.toString())).toMatch(
        new RegExp(`^${process.platform}-[0-9]+-[0-9]+$`, "u"),
      );
      await mkdir(join(root, "ordinary"));
      await mkdir(join(root, "😀"));
      await writeFile(join(root, "file"), "owned");
      await symlink(
        join(root, "ordinary"),
        join(root, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      for (const path of [join(root, "ordinary"), join(root, "😀")])
        expect(invoke(path).status).toBe(0);
      const denied = join(root, "denied");
      await mkdir(denied);
      if (process.platform === "darwin") await chmod(denied, 0);
      const inputs: (Buffer | string)[] = [
        "",
        "relative",
        ...(process.platform === "darwin"
          ? ["/", "/missing-sage-owned-folder"]
          : ["\\\\server\\share", "c:\\rejected-spelling"]),
        root + "/",
        root + "//ordinary",
        root + "/./ordinary",
        root + "/../",
        root + "/file",
        root + "/alias",
        root.replace("sage-root-native", "SAGE-ROOT-NATIVE"),
        ...(process.platform === "darwin"
          ? [denied]
          : [
              join(root, "missing-owned"),
              root + "\\",
              root + "\\\\ordinary",
              root + "\\.\\ordinary",
              root + "\\..",
              join(root, "file"),
              join(root, "alias"),
            ]),
        root + "\n",
        Buffer.alloc(16385, 97),
        Buffer.from([0xff]),
        Buffer.from([0xc2]),
        Buffer.from([0xc2, 0x41]),
        Buffer.from([0xe0, 0x80, 0x80]),
        Buffer.from([0xf0, 0x80, 0x80, 0x80]),
        Buffer.from([0xed, 0xa0, 0x80]),
        Buffer.from([0xf4, 0x90, 0x80, 0x80]),
        Buffer.from([0xc2, 0x80]),
        Buffer.from([0xc0, 0xaf]),
        root + "\0",
      ];
      for (const path of inputs) {
        const result = invoke(path);
        expect(result.status, String(path)).toBe(1);
        expect(result.stdout.length).toBe(0);
        expect(result.stderr.length).toBe(0);
      }
      for (const args of [[], ["--unknown"], ["--check-root-v1", "extra"]])
        expect(invoke(root, args).status).toBe(1);
      if (process.platform === "darwin") await chmod(denied, 0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mockSpawn.mockReset();
  nativeDouble.run = undefined;
  nativeDouble.files.clear();
  nativeDouble.directories.clear();
  vi.restoreAllMocks();
});
async function runtimeFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-root-runtime-")),
  );
  const probe = await buildRootProbe();
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "storage"));
  await copyFile(probe.path, join(root, "dist", probe.name));
  await chmod(join(root, "dist", probe.name), 0o755);
  vi.stubGlobal("__SAGE_ROOT_PROBE_SHA256__", probe.sha256);
  return {
    root,
    probe,
    invoke: (guard = () => {}) =>
      probeRoot(root, root, join(root, "storage"), guard),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
function childFixture(output?: Buffer, stderr?: Buffer) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
  child.stdin.once("finish", () =>
    queueMicrotask(() => {
      if (output) {
        child.stdout.write(output);
        if (stderr) child.stderr.write(stderr);
        child.exitCode = 0;
        child.emit("close", 0);
      }
    }),
  );
  return child;
}
it.runIf(nativeHost)(
  "runs only the hashed installed helper with closed stdin and a minimal owned environment",
  async () => {
    const fixture = await runtimeFixture();
    try {
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      mockSpawn.mockImplementation(actual.spawn);
      expect(await fixture.invoke()).toMatch(
        new RegExp(`^${process.platform}-[0-9]+-[0-9]+$`, "u"),
      );
      const [path, args, options] = mockSpawn.mock.calls[0];
      expect(path).toBe(join(fixture.root, "dist", fixture.probe.name));
      expect(args).toEqual(["--check-root-v1"]);
      expect(options).toMatchObject({
        shell: false,
        detached: false,
        env: { PATH: "" },
      });
      expect(Object.keys(options.env).sort()).toEqual(
        (process.platform === "win32"
          ? [
              "HOME",
              "HOMEDRIVE",
              "HOMEPATH",
              "LOGONSERVER",
              "USERDOMAIN",
              "USERNAME",
              "USERPROFILE",
              "SystemRoot",
              "WINDIR",
              "SystemDrive",
              "PATH",
              "TEMP",
              "TMP",
              "TMPDIR",
            ]
          : ["PATH", "TEMP", "TMP", "TMPDIR"]
        ).sort(),
      );
      expect(await readdir(join(fixture.root, "storage"))).toEqual([]);
      await writeFile(path, "drift");
      await expect(fixture.invoke()).rejects.toThrow();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  },
);
it.runIf(nativeHost)(
  "refuses malformed/non-ASCII/overflow/side-output records and always removes owned temp state",
  async () => {
    const fixture = await runtimeFixture();
    try {
      for (const [out, err] of [
        [Buffer.from("junk\n"), undefined],
        [Buffer.from("SAGE_ROOT_V1 darwin 1 2\n"), Buffer.from("error")],
        [Buffer.alloc(1025, 65), undefined],
        [
          Buffer.from(
            Buffer.from("SAGE_ROOT_V1 darwin 1 2\n").map((b) => b | 128),
          ),
          undefined,
        ],
        [Buffer.from("SAGE_ROOT_V1 darwin 1 2\n"), Buffer.alloc(1025, 65)],
      ] as const) {
        mockSpawn.mockImplementation(
          () => childFixture(out, err) as unknown as ChildProcess,
        );
        await expect(fixture.invoke()).rejects.toThrow();
        expect(await readdir(join(fixture.root, "storage"))).toEqual([]);
      }
    } finally {
      await fixture.cleanup();
    }
  },
);
it.runIf(nativeHost)(
  "times out and terminates only the same live owned child with bounded observation",
  async () => {
    const fixture = await runtimeFixture();
    const child = childFixture();
    let spawned!: () => void;
    const ready = new Promise<void>((r) => {
      spawned = r;
    });
    mockSpawn.mockImplementation(() => {
      spawned();
      return child as unknown as ChildProcess;
    });
    vi.useFakeTimers();
    try {
      const pending = fixture.invoke();
      const checked = expect(pending).rejects.toThrow();
      await ready;
      await vi.advanceTimersByTimeAsync(2000);
      expect(child.kill).toHaveBeenNthCalledWith(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      await vi.advanceTimersByTimeAsync(3000);
      await checked;
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(await readdir(join(fixture.root, "storage"))).toEqual([]);
    } finally {
      vi.useRealTimers();
      await fixture.cleanup();
    }
  },
);

// Tool doubles exercise loaded decisions only; actual Windows remains a CI gate.
async function windowsToolFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sage-tools-")));
  const compiler =
    "C:\\VS17\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64\\cl.exe";
  const linker =
    "C:\\VS17\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64\\link.exe";
  const clang = "C:\\Program Files\\LLVM\\bin\\clang-cl.exe";
  const profdata = "C:\\Program Files\\LLVM\\bin\\llvm-profdata.exe";
  const cov = "C:\\Program Files\\LLVM\\bin\\llvm-cov.exe";
  const runtime = "C:\\Program Files\\LLVM\\lib\\clang\\20\\lib\\windows";
  const library = runtime + "\\clang_rt.profile-x86_64.lib";
  const source = join(root, "extension/native/root-probe.c");
  await mkdir(join(root, "extension/native"), { recursive: true });
  await copyFile(join(process.cwd(), "extension/native/root-probe.c"), source);
  for (const path of [compiler, linker, clang, profdata, cov, library])
    nativeDouble.files.set(path, Buffer.from("owned installed tool " + path));
  nativeDouble.directories.add(runtime);
  const binary = Buffer.alloc(512);
  binary.write("MZ");
  binary.writeUInt32LE(128, 0x3c);
  binary.write("PE\0\0", 128);
  binary.writeUInt16LE(0x8664, 132);
  binary.writeUInt16LE(0x20b, 152);
  const calls: {
    command: string;
    args: string[];
    options: Record<string, unknown>;
  }[] = [];
  let damage = "";
  const run = (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    calls.push({ command, args, options });
    const result = {
      pid: 123,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    };
    if (args.includes("--version") || args[0] === "/?" || !args.length) {
      result.stdout =
        command === compiler || command === "cl.exe"
          ? "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35217 for x64\n"
          : command === linker
            ? "Microsoft (R) Incremental Linker Version 14.44.35217.0\n"
            : "LLVM version 20.1.8\nTarget: x86_64-pc-windows-msvc\n";
      if (damage === "failed-version") result.status = 1;
      return result;
    }
    if (args[0] === "/clang:-print-runtime-dir")
      return { ...result, stdout: runtime + "\n" };
    if (args[0] === "/clang:-print-prog-name=link")
      return { ...result, stdout: linker + "\n" };
    const output = args.find((a) => a.startsWith("/Fe:"));
    if (output) {
      writeFileSync(output.slice(4), binary);
      result.stdout = "root-probe.c\n";
      return result;
    }
    if (command === profdata && args[0] === "merge") {
      writeFileSync(args[args.indexOf("-o") + 1], "owned merged profile");
      return result;
    }
    if (command === cov && args[0] === "export")
      return {
        ...result,
        stdout: JSON.stringify({
          type: "llvm.coverage.json.export",
          version: "2.0.1",
          data: [
            {
              files: [
                {
                  filename: source,
                  branches: [],
                  segments: [],
                  expansions: [],
                  summary: {
                    regions: {
                      count: 10,
                      covered: 10,
                      notcovered: 0,
                      percent: 100,
                    },
                    branches: {
                      count: 10,
                      covered: 10,
                      notcovered: 0,
                      percent: 100,
                    },
                  },
                },
              ],
              functions: [],
              totals: {
                regions: { count: 10, covered: 10 },
                branches: { count: 10, covered: 10 },
              },
            },
          ],
        }),
      };
    throw Error("Unexpected tool command");
  };
  nativeDouble.run = (...input: unknown[]) => {
    const [command, args, options] = input as Parameters<typeof run>;
    if (damage === "missing-build" && args.some((a) => a.startsWith("/Fe:")))
      return {
        pid: 123,
        output: [null, "root-probe.c\n", ""],
        stdout: "root-probe.c\n",
        stderr: "",
        status: 0,
        signal: null,
      };
    if (damage === "missing-merge" && args[0] === "merge")
      return {
        pid: 123,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: 0,
        signal: null,
      };
    const result = run(command, args, options);
    const version = args.includes("--version") || args[0] === "/?";
    if (version) {
      if (damage === "version-stderr" && command === clang)
        return { ...result, stderr: "owned unexpected version diagnostic" };
      if (damage === "empty-version")
        return { ...result, stdout: "", stderr: "" };
      if (damage === "oversized-version")
        return { ...result, stdout: "x".repeat(65537) };
      if (damage === "unknown-version")
        return { ...result, stdout: "unrecognized installed tool" };
      if (damage === "null-status") return { ...result, status: null };
      if (damage === "spawn-error")
        return { ...result, error: Error("owned spawn failure") };
      if (damage === "timeout")
        return {
          ...result,
          error: Object.assign(Error("owned timeout"), { code: "ETIMEDOUT" }),
          signal: "SIGTERM",
        };
      if (damage === "mixed-major" && command === cov)
        return { ...result, stdout: result.stdout.replace("20.1.8", "19.1.8") };
      if (damage === "mixed-release" && command === profdata)
        return { ...result, stdout: result.stdout.replace("20.1.8", "20.1.7") };
      if (damage === "wrong-target" && command === clang)
        return {
          ...result,
          stdout: result.stdout.replace(
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
          ),
        };
    }
    if (damage === "runtime-family" && args[0] === "/clang:-print-runtime-dir")
      return { ...result, stdout: "C:\\OtherLLVM\\lib\\windows\n" };
    if (
      damage === "runtime-forward-slash" &&
      args[0] === "/clang:-print-runtime-dir"
    )
      return { ...result, stdout: runtime.replaceAll("\\", "/") + "\n" };
    if (
      damage === "linker-family" &&
      args[0] === "/clang:-print-prog-name=link"
    )
      return { ...result, stdout: "C:\\OtherVS\\link.exe\n" };
    if (args.some((a) => a.startsWith("/Fe:"))) {
      if (damage === "compile-warning")
        return { ...result, stderr: "owned warning marker" };
      if (damage === "compile-stdout")
        return { ...result, stdout: "owned unknown diagnostic" };
      if (damage === "compile-exit") return { ...result, status: 1 };
      if (damage === "wrong-pe")
        writeFileSync(
          args.find((a) => a.startsWith("/Fe:"))!.slice(4),
          Buffer.alloc(512),
        );
    }
    if (args[0] === "merge") {
      if (damage === "failed-merge") return { ...result, status: 1 };
      if (damage === "merge-diagnostic")
        return { ...result, stderr: "owned merge diagnostic" };
      if (damage === "empty-merge")
        writeFileSync(args[args.indexOf("-o") + 1], "");
    }
    if (args[0] === "export") {
      if (damage === "profile-hash")
        writeFileSync(
          join(root, ".cache/native-coverage/run-1-0.profraw"),
          "owned profile drift during export",
        );
      if (damage === "tool-hash-during-export")
        nativeDouble.files.set(
          cov,
          Buffer.from("owned tool drift during export"),
        );
      if (damage === "failed-export") return { ...result, status: 1 };
      if (damage === "malformed-export") return { ...result, stdout: "{" };
      if (damage === "empty-export") return { ...result, stdout: "" };
      if (damage === "export-diagnostic")
        return { ...result, stderr: "owned export diagnostic" };
      const packet = JSON.parse(result.stdout);
      if (damage === "export-version-three") packet.version = "3.0.1";
      if (damage === "unknown-export-version") packet.version = "99.0.1";
      if (damage === "zero-denominator")
        packet.data[0].files[0].summary.branches.count = 0;
      if (damage === "below-threshold")
        packet.data[0].files[0].summary.branches.covered = 8;
      if (damage === "missing-source") packet.data[0].files = [];
      if (damage === "wrong-source")
        packet.data[0].files[0].filename = source + ".other";
      if (damage === "malformed-count")
        packet.data[0].files[0].summary.regions.covered = "10";
      return { ...result, stdout: JSON.stringify(packet) };
    }
    return result;
  };
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubGlobal("process", {
    ...process,
    platform: "win32",
    arch: "x64",
    cwd: () => root,
    env: {
      ...process.env,
      RUNNER_OS: "Windows",
      RUNNER_ARCH: "X64",
      VCToolsInstallDir: "C:\\VS17\\VC\\Tools\\MSVC\\14.44\\",
      PATH: "C:\\VS17\\VC\\Tools\\MSVC\\14.44\\bin\\Hostx64\\x64",
      VSCMD_ARG_HOST_ARCH: "x64",
      VSCMD_ARG_TGT_ARCH: "x64",
    },
  });
  return {
    root,
    compiler,
    linker,
    clang,
    profdata,
    cov,
    runtime,
    library,
    calls,
    binary,
    source,
    damage: (value: string) => {
      damage = value;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("installed native builder decisions", () => {
  it("accepts the actual installed Apple LLVM export version with complete counters", async () => {
    const fixture = await windowsToolFixture();
    try {
      await buildRootProbe(true);
      await writeFile(
        join(fixture.root, ".cache/native-coverage/run-1-0.profraw"),
        "owned profile",
      );
      await reportNativeCoverage();
      fixture.damage("export-version-three");
      await expect(reportNativeCoverage()).resolves.toBeUndefined();
      const packet = JSON.parse(
        await readFile(
          join(fixture.root, ".cache/native-coverage/coverage.json"),
          "utf8",
        ),
      );
      expect(packet.coverage.version).toBe("3.0.1");
      expect(packet.coverage.data[0].files[0].summary.branches).toMatchObject({
        count: 10,
        covered: 10,
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it("accepts the same absolute installed runtime with native Windows slash spelling", async () => {
    const fixture = await windowsToolFixture();
    try {
      await buildRootProbe(true);
      fixture.damage("runtime-forward-slash");
      await expect(buildRootProbe(true)).resolves.toMatchObject({
        name: "root-probe-win32-x64.exe",
      });
    } finally {
      await fixture.cleanup();
    }
  });
  it("reports an existing valid Windows coverage packet using installed profile tools instead of xcrun", async () => {
    const fixture = await windowsToolFixture();
    try {
      const built = await buildRootProbe();
      const dir = join(fixture.root, ".cache/native-coverage");
      await mkdir(dir, { recursive: true });
      await copyFile(built.path, join(dir, built.name));
      const digest = (bytes: Buffer) =>
        createHash("sha256").update(bytes).digest("hex");
      const tool = (path: string, version: string) => ({
        path,
        version,
        sha256: digest(nativeDouble.files.get(path)!),
      });
      const llvm = "LLVM version 20.1.8\nTarget: x86_64-pc-windows-msvc";
      await writeFile(
        join(dir, "provenance.json"),
        JSON.stringify({
          compiler: fixture.clang,
          version: llvm,
          coverage: true,
          target: "win32-x64",
          source_sha256: digest(await readFile(fixture.source)),
          sha256: built.sha256,
          size: fixture.binary.length,
          toolchain: {
            compiler: tool(fixture.clang, llvm),
            msvc: tool(
              fixture.compiler,
              "Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35217 for x64",
            ),
            linker: tool(
              fixture.linker,
              "Microsoft (R) Incremental Linker Version 14.44.35217.0",
            ),
            profdata: tool(fixture.profdata, llvm),
            cov: tool(fixture.cov, llvm),
            runtime: {
              path: fixture.library,
              sha256: digest(nativeDouble.files.get(fixture.library)!),
            },
          },
        }),
      );
      await writeFile(join(dir, "run-1-0.profraw"), "owned profile");
      await reportNativeCoverage();
      const packet = JSON.parse(
        await readFile(join(dir, "coverage.json"), "utf8"),
      );
      expect(packet.platform).toBe("win32-x64");
      expect(
        fixture.calls
          .filter((c) => c.args.includes("merge"))
          .map((c) => c.command),
      ).toEqual([fixture.profdata]);
    } finally {
      await fixture.cleanup();
    }
  });
  it("builds separate Windows coverage with verified installed LLVM and merges with that family", async () => {
    const fixture = await windowsToolFixture();
    try {
      const production = await buildRootProbe();
      const instrumented = await buildRootProbe(true);
      expect(production.path).not.toBe(instrumented.path);
      const provenance = JSON.parse(
        await readFile(
          join(fixture.root, ".cache/native-coverage/provenance.json"),
          "utf8",
        ),
      );
      expect(provenance.coverage).toBe(true);
      expect(provenance.compiler).toBe(fixture.clang);
      await writeFile(
        join(fixture.root, ".cache/native-coverage/run-1-0.profraw"),
        "owned profile",
      );
      await reportNativeCoverage();
      const report = JSON.parse(
        await readFile(
          join(fixture.root, ".cache/native-coverage/coverage.json"),
          "utf8",
        ),
      );
      expect(report.platform).toBe("win32-x64");
      expect(report.binary_sha256).toBe(
        createHash("sha256").update(fixture.binary).digest("hex"),
      );
      expect(
        fixture.calls
          .filter((c) => c.args.includes("merge"))
          .map((c) => c.command),
      ).toEqual([fixture.profdata]);
      expect(
        fixture.calls
          .filter((c) => c.args.includes("export"))
          .map((c) => c.command),
      ).toEqual([fixture.cov]);
      const builds = fixture.calls.filter((c) =>
        c.args.some((a) => a.startsWith("/Fe:")),
      );
      expect(builds.map((c) => c.command)).toEqual([
        fixture.compiler,
        fixture.clang,
      ]);
      expect(builds[0].args).not.toContain("-fcoverage-mapping");
      expect(builds[1].args).toContain("-fcoverage-mapping");
      expect(builds[0].args).toEqual([
        "/nologo",
        "/W4",
        "/WX",
        "/O2",
        "/TC",
        fixture.source,
        `/Fe:${production.path}`,
        `/Fo:${join(fixture.root, ".cache/root-probe/root-probe.obj")}`,
        "/link",
        "advapi32.lib",
      ]);
      expect(builds[1].args).toEqual([
        "/nologo",
        "/W4",
        "/WX",
        "/O2",
        "/TC",
        "-fprofile-instr-generate",
        "-fcoverage-mapping",
        fixture.source,
        `/Fe:${instrumented.path}`,
        `/Fo:${join(fixture.root, ".cache/native-coverage/root-probe.obj")}`,
        "/link",
        "advapi32.lib",
      ]);
      for (const call of fixture.calls)
        expect(call.options).toMatchObject({
          shell: false,
          input: "",
          timeout: 30000,
          cwd: expect.stringContaining(".cache"),
          maxBuffer: call.args[0] === "export" ? 1048576 : 65536,
        });
      expect(
        fixture.calls.filter(
          (c) =>
            [fixture.compiler, fixture.linker].includes(c.command) &&
            c.args[0] === "/?",
        ).length,
      ).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  });
  it("stops before compiler execution after an unsuccessful version probe", async () => {
    const fixture = await windowsToolFixture();
    try {
      fixture.damage("failed-version");
      await expect(buildRootProbe()).rejects.toThrow();
      expect(
        fixture.calls.some((c) => c.args.some((a) => a.startsWith("/Fe:"))),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
  it.each([
    "failed-version",
    "empty-version",
    "oversized-version",
    "unknown-version",
    "version-stderr",
    "null-status",
    "spawn-error",
    "timeout",
    "mixed-major",
    "mixed-release",
    "wrong-target",
    "runtime-family",
    "linker-family",
    "missing-tool",
    "missing-runtime",
    "empty-runtime",
    "tool-hash",
    "compile-warning",
    "compile-stdout",
    "compile-exit",
    "wrong-pe",
    "missing-build",
  ])("fails closed from a valid installed baseline: %s", async (damage) => {
    const fixture = await windowsToolFixture();
    try {
      await buildRootProbe(true);
      const before = fixture.calls.length;
      if (damage === "missing-tool") nativeDouble.files.delete(fixture.cov);
      else if (damage === "missing-runtime")
        nativeDouble.files.delete(fixture.library);
      else if (damage === "empty-runtime")
        nativeDouble.files.set(fixture.library, Buffer.alloc(0));
      else if (damage === "tool-hash") {
        // Cached provenance cannot bypass a changed installed tool identity.
        await writeFile(
          join(fixture.root, ".cache/native-coverage/run-1-0.profraw"),
          "owned profile",
        );
        nativeDouble.files.set(
          fixture.cov,
          Buffer.from("changed installed tool"),
        );
        await expect(reportNativeCoverage()).rejects.toThrow(
          "Native coverage report failed",
        );
        return;
      } else fixture.damage(damage);
      await expect(buildRootProbe(true)).rejects.toThrow(
        "Native root probe build failed",
      );
      if (
        ![
          "compile-warning",
          "compile-stdout",
          "compile-exit",
          "wrong-pe",
          "missing-build",
        ].includes(damage)
      )
        expect(
          fixture.calls
            .slice(before)
            .some((c) => c.args.some((a) => a.startsWith("/Fe:"))),
        ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
  it.each([
    "failed-merge",
    "merge-diagnostic",
    "empty-merge",
    "missing-merge",
    "failed-export",
    "malformed-export",
    "unknown-export-version",
    "empty-export",
    "export-diagnostic",
    "zero-denominator",
    "below-threshold",
    "missing-source",
    "wrong-source",
    "malformed-count",
    "missing-profile",
    "empty-profile",
    "stale-profile",
    "source-hash",
    "binary-hash",
    "runtime-hash",
    "profile-hash",
    "tool-hash-during-export",
  ])(
    "rejects damaged coverage after a valid complete export: %s",
    async (damage) => {
      const fixture = await windowsToolFixture();
      try {
        await buildRootProbe(true);
        const profile = join(
          fixture.root,
          ".cache/native-coverage/run-1-0.profraw",
        );
        await writeFile(profile, "owned profile");
        await reportNativeCoverage();
        if (damage === "missing-profile") await rm(profile);
        else if (damage === "empty-profile") await writeFile(profile, "");
        else if (damage === "stale-profile") await utimes(profile, 1, 1);
        else if (damage === "source-hash")
          await writeFile(fixture.source, "owned source drift");
        else if (damage === "binary-hash")
          await writeFile(
            join(
              fixture.root,
              ".cache/native-coverage/root-probe-win32-x64.exe",
            ),
            "owned binary drift",
          );
        else if (damage === "runtime-hash")
          nativeDouble.files.set(
            fixture.library,
            Buffer.from("owned runtime drift"),
          );
        else fixture.damage(damage);
        await expect(reportNativeCoverage()).rejects.toThrow(
          "Native coverage report failed",
        );
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
