import { afterEach, expect, it, vi } from "vitest";
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
} from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));
import { buildRootProbe } from "../../../scripts/build-root-probe";
it.runIf(process.platform === "darwin" && process.arch === "arm64")(
  "exercises the actual fixed native helper on local folders and refuses aliases/invalid bytes",
  async () => {
    const root = await realpath(
      await mkdtemp("/private/tmp/sage-root-native-"),
    );
    try {
      const coverage = process.env.SAGE_NATIVE_COVERAGE === "1",
        probe = await buildRootProbe(coverage);
      let sequence = 0;
      const invoke = (input: Buffer | string, args = ["--check-root-v1"]) =>
        spawnSync(probe.path, args, {
          shell: false,
          input,
          env: {
            PATH: "",
            TEMP: root,
            TMP: root,
            TMPDIR: root,
            ...(coverage
              ? {
                  LLVM_PROFILE_FILE: join(
                    process.cwd(),
                    `.cache/task4-native-coverage/run-${process.pid}-${sequence++}.profraw`,
                  ),
                }
              : {}),
          },
          timeout: 2000,
          maxBuffer: 2048,
        });
      const valid = invoke(root);
      expect(valid.status).toBe(0);
      expect(valid.stderr.length).toBe(0);
      expect(parseRootProbe(valid.stdout.toString())).toMatch(
        /^darwin-[0-9]+-[0-9]+$/u,
      );
      await mkdir(join(root, "ordinary"));
      await mkdir(join(root, "😀"));
      await writeFile(join(root, "file"), "owned");
      await symlink(join(root, "ordinary"), join(root, "alias"));
      for (const path of [join(root, "ordinary"), join(root, "😀")])
        expect(invoke(path).status).toBe(0);
      const denied = join(root, "denied");
      await mkdir(denied);
      await chmod(denied, 0);
      const inputs: (Buffer | string)[] = [
        "",
        "relative",
        "/",
        "/missing-sage-owned-folder",
        root + "/",
        root + "//ordinary",
        root + "/./ordinary",
        root + "/../",
        root + "/file",
        root + "/alias",
        root.replace("sage-root-native", "SAGE-ROOT-NATIVE"),
        denied,
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
      await chmod(denied, 0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mockSpawn.mockReset();
});
async function runtimeFixture() {
  const root = await realpath(await mkdtemp("/private/tmp/sage-root-runtime-"));
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
it.runIf(process.platform === "darwin" && process.arch === "arm64")(
  "runs only the hashed installed helper with closed stdin and a minimal owned environment",
  async () => {
    const fixture = await runtimeFixture();
    try {
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      mockSpawn.mockImplementation(actual.spawn);
      expect(await fixture.invoke()).toMatch(/^darwin-[0-9]+-[0-9]+$/u);
      const [path, args, options] = mockSpawn.mock.calls[0];
      expect(path).toBe(join(fixture.root, "dist", fixture.probe.name));
      expect(args).toEqual(["--check-root-v1"]);
      expect(options).toMatchObject({
        shell: false,
        detached: false,
        env: { PATH: "" },
      });
      expect(Object.keys(options.env).sort()).toEqual([
        "PATH",
        "TEMP",
        "TMP",
        "TMPDIR",
      ]);
      expect(await readdir(join(fixture.root, "storage"))).toEqual([]);
      await writeFile(path, "drift");
      await expect(fixture.invoke()).rejects.toThrow();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.cleanup();
    }
  },
);
it.runIf(process.platform === "darwin" && process.arch === "arm64")(
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
it.runIf(process.platform === "darwin" && process.arch === "arm64")(
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
