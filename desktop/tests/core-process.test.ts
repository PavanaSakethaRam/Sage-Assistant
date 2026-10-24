import { afterEach, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startCore, deployment } from "../main/core-process";
import { encodeFrame, FrameDecoder } from "../shared/framing";
import type { CoreOptions } from "../main/core-process";
import type { CoreRequest } from "../shared/contracts";
// A test-only spawn seam runs only registered owned scripts through Node on
// Windows. All production launch options and unregistered executables pass through.
const syntheticExecutables = vi.hoisted(() => new Set<string>());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const intercepted = (
    file: string,
    args: readonly string[],
    options: import("node:child_process").SpawnOptions,
  ) =>
    syntheticExecutables.has(file) && process.platform === "win32"
      ? actual.spawn(process.execPath, [file, ...args], options)
      : actual.spawn(file, args, options);
  return {
    ...actual,
    spawn: intercepted as unknown as typeof actual.spawn,
  };
});
const subprocessIt = it;
const owned: ReturnType<typeof startCore>[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((core) => core.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  syntheticExecutables.clear();
});
const request = (
  id: string,
  method = "settings.get",
  params: unknown = {},
): CoreRequest =>
  ({ version: 1, id, kind: "request", method, params }) as CoreRequest;
async function fake(mode = "normal") {
  const root = await mkdtemp(join(tmpdir(), "sage-host-test-"));
  roots.push(root);
  const executable = join(root, "child");
  await writeFile(
    executable,
    `#!${process.execPath}\n${String.raw`
 const fs=require('node:fs'); let input=Buffer.alloc(0); const mode=MODE;const root=process.argv[process.argv.indexOf('--root')+1];fs.appendFileSync(root+'/launches','1\n');
 let selected=null;const held=[];let heldSelection;
 const send=value=>{const b=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));};
 process.stderr.write('SYNTHETIC_SECRET raw exception\n');fs.writeFileSync(process.argv[process.argv.indexOf('--root')+1]+'/pid',String(process.pid));if(mode==='stubborn'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
 process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE(0)){const n=input.readUInt32BE(0);const r=JSON.parse(input.subarray(4,4+n));input=input.subarray(4+n);
 if(mode==='exit'||(mode==='selection-restart'&&r.id==='crash')){process.exit(3);return;}
 if(mode==='partial'){process.stdout.write(Buffer.from([0]));return;}
 if(mode==='overflow'){process.stdout.write(Buffer.from([0,16,0,1]));return;}
 let result=r.method==='app.shutdown'?{status:'shutting_down'}:r.method==='reasoning.cancel'?{status:'cancelled'}:r.method==='reasoning.start'?{status:'completed',task_id:'t',text:'late',proposal:null,usage:null}:{ai_mode:'local',reasoning_backend:null};
 if(mode==='ready'&&['connection.test','readiness.list'].includes(r.method)){const ready={provider:'copilot',status:'ready',evidence:['explicit_synthetic_check'],version:'sdk:1.0.25/runtime:1.0.102',destination:'GitHub Copilot cloud',diagnostic:null,explanation:'explicit_connection_check_succeeded'};result=r.method==='readiness.list'?{items:[ready]}:ready;}
 if(mode==='saturated-selection'&&r.kind==='request'&&r.method==='settings.get'){held.push(r);fs.writeFileSync(root+'/held',String(held.length));continue;}
 if(r.kind==='host_copilot_selection'){if(mode==='control-overlap'&&r.account){fs.appendFileSync(root+'/selection-frames',JSON.stringify(r)+'\n');heldSelection=r;fs.writeFileSync(root+'/selection-held','1');continue;}if(mode==='control-overlap'&&heldSelection){send({version:1,id:heldSelection.id,kind:'response',result:{generation:heldSelection.generation,status:'selected'}});heldSelection=undefined;}if(mode==='saturated-selection'){selected=r.account;fs.writeFileSync(root+'/selected',JSON.stringify(selected));if(!selected){fs.writeFileSync(root+'/disposed',String(held.length));for(const old of held.splice(0))send({version:1,id:old.id,kind:'error',code:'cancelled'});}}fs.appendFileSync(root+'/selection-frames',JSON.stringify(r)+'\n');result={generation:mode==='selection-mismatch'?r.generation+1:r.generation,status:r.account?'selected':'cleared'};}
 if(mode==='environment'&&(process.env.GITHUB_TOKEN||process.env.GH_TOKEN||process.env.NODE_OPTIONS||process.env.PYTHONPATH||process.env.PATH||process.env.HOME||process.env.HOMEDRIVE||process.env.HOMEPATH||process.env.LOGONSERVER||process.env.USERDOMAIN||process.env.USERNAME||process.env.USERPROFILE)) result.ai_mode='bad';
 const answer={version:['protocol','stubborn'].includes(mode)?2:1,id:r.id,kind:'response',result};
 if(mode==='late'&&r.id==='slow') setTimeout(()=>send(answer),70);else send(answer);
 if(r.method==='app.shutdown') {process.stdin.pause();process.exit(0);}
 }});process.stdin.on('end',()=>{if(mode!=='stubborn')process.exit(0);});
 `.replace("MODE", JSON.stringify(mode))}`,
  );
  await chmod(executable, 0o700);
  syntheticExecutables.add(executable);
  const core = startCore({ executable, dataDir: root });
  owned.push(core);
  return core;
}
it("frames fragmented bounded UTF8 and rejects duplicate keys/depth/surrogates/oversize", () => {
  const decoder = new FrameDecoder();
  const b = encodeFrame({
    version: 1,
    id: "a",
    kind: "error",
    code: "cancelled",
  });
  expect(decoder.push(b.subarray(0, 2))).toEqual([]);
  expect(decoder.push(b.subarray(2))).toEqual([
    { version: 1, id: "a", kind: "error", code: "cancelled" },
  ]);
  for (const body of [
    '\ufeff{"id":"a"}',
    '{"id":"a","id":"b"}',
    '{"a":"\\ud800"}',
    '{"a":NaN}',
    "[".repeat(34) + "0" + "]".repeat(34),
  ]) {
    const bytes = Buffer.from(body);
    const h = Buffer.alloc(4);
    h.writeUInt32BE(bytes.length);
    expect(() => new FrameDecoder().push(Buffer.concat([h, bytes]))).toThrow();
  }
  expect(() => new FrameDecoder().push(Buffer.from([0, 16, 0, 1]))).toThrow();
  const exact = encodeFrame({ x: "x".repeat(1048568) });
  expect(exact.length).toBe(1048580);
  expect(() => encodeFrame({ x: "x".repeat(1048569) })).toThrow();
  expect(() =>
    new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 255])),
  ).toThrow();
});
it("derives deployment solely from trusted project/resources locations", () => {
  const paths = (value: CoreOptions) => ({
    ...value,
    executable: value.executable.replaceAll("\\", "/"),
    runtimePath: value.runtimePath?.replaceAll("\\", "/"),
  });
  expect(
    paths(
      deployment({
        packaged: false,
        projectDir: "/project",
        resourcesDir: "/resources",
        dataDir: "/state",
        platform: "darwin",
        arch: "arm64",
      }),
    ),
  ).toMatchObject({
    executable: "/project/.venv/bin/python",
    runtimePath:
      "/project/.runtime/copilot/1.0.102/prebuilds/darwin-arm64/copilot-runtime",
    pythonModule: true,
    dataDir: "/state",
  });
  expect(
    paths(
      deployment({
        packaged: true,
        projectDir: "/evil",
        resourcesDir: "/resources",
        dataDir: "/state",
        platform: "win32",
        arch: "x64",
      }),
    ),
  ).toMatchObject({
    executable: "/resources/core/sage-core.exe",
    runtimePath:
      "/resources/copilot/1.0.102/prebuilds/win32-x64/copilot-runtime.exe",
    pythonModule: false,
  });
  expect(() =>
    startCore({ executable: "python", dataDir: "/state" }),
  ).toThrow();
});
subprocessIt(
  "correlates concurrent IDs, disallows reuse and strips ambient credentials/environment",
  async () => {
    const blocked = [
      "GITHUB_TOKEN",
      "PATH",
      "HOMEDRIVE",
      "HOMEPATH",
      "LOGONSERVER",
      "USERDOMAIN",
      "USERNAME",
      "USERPROFILE",
    ] as const;
    const before = Object.fromEntries(
      blocked.map((key) => [key, process.env[key]]),
    );
    process.env.GITHUB_TOKEN = "SYNTHETIC_SECRET";
    for (const key of blocked)
      if (key !== "GITHUB_TOKEN") process.env[key] = `synthetic-parent-${key}`;
    try {
      const core = await fake("environment");
      const out = await Promise.all([
        core.request(request("a")),
        core.request(request("b")),
      ]);
      expect(out.map((r) => r.id)).toEqual(["a", "b"]);
      expect(out.every((r) => r.kind === "response")).toBe(true);
      expect(await core.request(request("a"))).toMatchObject({
        kind: "error",
        code: "duplicate_id",
      });
    } finally {
      for (const key of blocked) {
        const value = before[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
subprocessIt.each(["protocol", "overflow"])(
  "fails closed on %s without echoing stderr",
  async (mode) => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const core = await fake(mode);
    expect(await core.request(request("a"))).toMatchObject({
      kind: "error",
      code: "internal_error",
    });
    await core.close();
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    stderr.mockRestore();
    expect(output).not.toContain("SYNTHETIC_SECRET");
    expect(await core.request(request("b"))).toMatchObject({
      code: "shutting_down",
    });
  },
);
subprocessIt(
  "bounds restarts after child exits and never replays pending work",
  async () => {
    const core = await fake("exit");
    for (const id of ["a", "b", "c"])
      expect(await core.request(request(id))).toMatchObject({
        kind: "error",
        code: "internal_error",
      });
    expect(
      (await readFile(join(roots.at(-1)!, "launches"), "utf8"))
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(2);
  },
);
subprocessIt(
  "invalidates cancelled work and ignores a late response while serving later requests",
  async () => {
    const core = await fake("late");
    const slow = core.request(
      request("slow", "reasoning.start", {
        user_text: "x",
        backend: "copilot",
      }),
    );
    expect(await core.cancel("slow")).toMatchObject({ kind: "response" });
    expect(await slow).toMatchObject({ kind: "error", code: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(await core.request(request("next"))).toMatchObject({
      kind: "response",
      id: "next",
    });
  },
);
subprocessIt(
  "invalidates deadlines and closes/reaps its owned child idempotently",
  async () => {
    const core = await fake("partial");
    expect(
      await core.request({ ...request("timeout"), timeout_ms: 25 }),
    ).toMatchObject({ code: "timeout" });
    await core.close();
    await core.close();
    expect(await core.request(request("after-close"))).toMatchObject({
      code: "shutting_down",
    });
  },
);
it("runs the actual fixed isolated Python core for local notes and unavailable runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-real-core-"));
  roots.push(root);
  const core = startCore({
    executable: resolve(
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    ),
    pythonModule: true,
    dataDir: root,
    runtimePath: join(root, "missing-runtime"),
  });
  owned.push(core);
  expect(await core.request(request("settings"))).toMatchObject({
    result: { ai_mode: "local", reasoning_backend: null },
  });
  const note = await core.request(
    request("propose", "notes.propose", {
      title: "😀".repeat(200),
      body: "literal\nbody",
    }),
  );
  expect(note).toMatchObject({
    kind: "response",
    result: { arguments: { body: "literal\nbody" }, revision: 1 },
  });
  expect(
    await core.request(request("readiness", "readiness.list")),
  ).toMatchObject({
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({ provider: "copilot", status: "unavailable" }),
      ]),
    },
  });
  await core.close();
  expect(await core.request(request("after-close"))).toMatchObject({
    code: "shutting_down",
  });
});

subprocessIt(
  "reaps an invalid-protocol child even when it ignores termination",
  async () => {
    const core = await fake("stubborn");
    expect(await core.request(request("a"))).toMatchObject({
      code: "internal_error",
    });
    const pid = Number(await readFile(join(roots.at(-1)!, "pid"), "utf8"));
    try {
      await core.close();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  },
);

subprocessIt(
  "reasoning cancellation cannot suppress a local operation response",
  async () => {
    const core = await fake("late");
    const local = core.request(request("slow"));
    await core.cancel("slow");
    expect(await local).toMatchObject({
      kind: "response",
      id: "slow",
      result: { ai_mode: "local" },
    });
  },
);

subprocessIt(
  "valid ready replies leave the owned core alive without restarting",
  async () => {
    const core = await fake("ready");
    await core.request(request("before"));
    const root = roots.at(-1)!;
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    const ready = {
      provider: "copilot",
      status: "ready",
      evidence: ["explicit_synthetic_check"],
      version: "sdk:1.0.25/runtime:1.0.102",
      destination: "GitHub Copilot cloud",
      explanation: "explicit_connection_check_succeeded",
      diagnostic: null,
    };
    for (const method of ["connection.test", "readiness.list"] as const) {
      expect(
        await core.request(request(method.replace(".", "-"), method)),
      ).toEqual({
        version: 1,
        id: method.replace(".", "-"),
        kind: "response",
        result: method === "readiness.list" ? { items: [ready] } : ready,
      });
    }
    expect(await core.request(request("after"))).toMatchObject({
      kind: "response",
      id: "after",
      result: { ai_mode: "local" },
    });
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await readFile(join(root, "pid"), "utf8")).toBe(String(pid));
    expect(await readFile(join(root, "launches"), "utf8")).toBe("1\n");
  },
);

it("private selection correlates and clears in the real core without becoming ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-selection-core-"));
  roots.push(root);
  const core = startCore({
    executable: resolve(
      ".venv",
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    ),
    pythonModule: true,
    dataDir: root,
  });
  owned.push(core);
  await core.request(
    request("assistant-mode", "settings.update", {
      ai_mode: "assistant",
      reasoning_backend: "copilot",
    }),
  );
  expect(
    await core.selectAccount({ host: "github.com", login: "synthetic-user" }),
  ).toEqual({ generation: 1, status: "selected" });
  expect(await core.selectAccount(null)).toEqual({
    generation: 2,
    status: "cleared",
  });
  expect(
    await core.request(request("account-renderer", "copilot.chooseAccount")),
  ).toMatchObject({ code: "invalid_request" });
  expect(
    await core.request(request("after-selection", "readiness.list")),
  ).toMatchObject({
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({
          provider: "copilot",
          status: "auth_required",
        }),
      ]),
    },
  });
});

subprocessIt(
  "core restart starts a fresh selection boot and cannot replay an account",
  async () => {
    const core = await fake("selection-restart");
    const root = roots.at(-1)!;
    expect(
      await core.selectAccount({ host: "github.com", login: "synthetic-user" }),
    ).toEqual({ generation: 1, status: "selected" });
    expect(await core.request(request("crash"))).toMatchObject({
      code: "internal_error",
    });
    expect(await core.selectAccount(null)).toEqual({
      generation: 1,
      status: "cleared",
    });
    const frames = (await readFile(join(root, "selection-frames"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames).toHaveLength(2);
    expect(frames[0].boot_id).not.toBe(frames[1].boot_id);
    expect(frames[1].account).toBeNull();
  },
);
subprocessIt(
  "wrong selection acknowledgement generation closes its owned core",
  async () => {
    const core = await fake("selection-mismatch");
    await expect(core.selectAccount(null)).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "host waits for bounded core cleanup before killing a parent with owned helper descendants",
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "sage-shutdown-tree-")),
    );
    roots.push(root);
    const executable = join(root, "core-fixture");
    await symlink(resolve(".venv/bin/python"), join(root, "fixture-python"));
    const fixtureSource = await readFile(
      resolve("desktop/tests/fixtures/shutdown-core.py"),
      "utf8",
    );
    await writeFile(
      executable,
      `#!${join(root, "fixture-python")}\n${fixtureSource.replace(JSON.stringify("__SAGE_TEST_PROJECT__"), JSON.stringify(resolve(".")))}`,
    );
    await chmod(executable, 0o700);
    const core = startCore({ executable, dataDir: root });
    owned.push(core);
    let pids: number[] = [];
    const waitFor = async (file: string) => {
      for (let i = 0; i < 500; i++) {
        try {
          return await readFile(join(root, file), "utf8");
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      throw new Error("Synthetic worker did not start");
    };
    try {
      expect(
        await core.request(
          request("settings", "settings.update", {
            ai_mode: "assistant",
            reasoning_backend: "copilot",
          }),
        ),
      ).toMatchObject({ result: { ai_mode: "assistant" } });
      const fast = core.request(
        request("fast-sdk", "reasoning.start", {
          user_text: "synthetic",
          backend: "copilot",
        }),
      );
      await waitFor("fast-started");
      const slow = core.request(
        request("slow-helper", "reasoning.start", {
          user_text: "synthetic",
          backend: "copilot",
        }),
      );
      pids = (await waitFor("helper-pids")).split(" ").map(Number);
      pids.push(Number(await waitFor("sdk-pid")));
      const start = performance.now();
      await core.close();
      const alive = pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      expect(alive).toEqual([]);
      expect(performance.now() - start).toBeGreaterThan(1200);
      await Promise.all([fast, slow]);
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Owned fixture already reaped. */
        }
      }
      await core.close();
    }
  },
  10000,
);

subprocessIt(
  "private clear bypasses eight public slots and acknowledges only after old work is disposed",
  async () => {
    const core = await fake("saturated-selection");
    const root = roots.at(-1)!;
    await core.selectAccount({ host: "github.com", login: "synthetic-user" });
    const work = Array.from({ length: 8 }, (_, i) =>
      core.request(request(`held-${i}`)),
    );
    for (let i = 0; i < 200; i++) {
      try {
        if ((await readFile(join(root, "held"), "utf8")) === "8") break;
      } catch {
        /* Worker has not read the requests yet. */
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await readFile(join(root, "held"), "utf8")).toBe("8");
    expect(await core.request(request("ninth"))).toMatchObject({
      code: "busy",
    });
    expect(await core.selectAccount(null)).toEqual({
      generation: 2,
      status: "cleared",
    });
    expect(await readFile(join(root, "selected"), "utf8")).toBe("null");
    expect(await readFile(join(root, "disposed"), "utf8")).toBe("8");
    expect(
      (await Promise.all(work)).every(
        (result) => result.kind === "error" && result.code === "cancelled",
      ),
    ).toBe(true);
  },
);

subprocessIt(
  "reserves one coalesced clear behind an in-flight selection without unbounded controls",
  async () => {
    const core = await fake("control-overlap");
    const root = roots.at(-1)!;
    const selecting = core.selectAccount({
      host: "github.com",
      login: "synthetic-user",
    });
    for (let i = 0; i < 200; i++) {
      try {
        await readFile(join(root, "selection-held"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    const clearA = core.selectAccount(null);
    const clearB = core.selectAccount(null);
    expect(clearA).toBe(clearB);
    await expect(
      core.selectAccount({ host: "github.com", login: "other" }),
    ).rejects.toThrow();
    expect(await selecting).toEqual({ generation: 1, status: "selected" });
    expect(await clearA).toEqual({ generation: 2, status: "cleared" });
    const frames = (await readFile(join(root, "selection-frames"), "utf8"))
      .trim()
      .split("\n");
    expect(frames).toHaveLength(2);
  },
);
subprocessIt(
  "session-budget revocation failure closes the owned core before reporting unavailable",
  async () => {
    const core = await fake("saturated-selection");
    const root = roots.at(-1)!;
    await core.selectAccount({ host: "github.com", login: "synthetic-user" });
    const work = Array.from({ length: 8 }, (_, i) =>
      core.request(request(`held-${i}`)),
    );
    for (let i = 0; i < 4087; i++) await core.request(request(`busy-${i}`));
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    await expect(core.selectAccount(null)).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      (await Promise.all(work)).every((result) => result.kind === "error"),
    ).toBe(true);
    expect(await core.request(request("after-failed-clear"))).toMatchObject({
      code: "shutting_down",
    });
  },
);
it("refuses an overfull decode batch before returning any frames", () => {
  const bytes = Buffer.concat(
    Array.from({ length: 9 }, () => encodeFrame({ x: 1 })),
  );
  expect(() => new FrameDecoder().push(bytes, 8)).toThrow();
  expect(
    new FrameDecoder().push(bytes.subarray(0, bytes.length - 11), 8),
  ).toHaveLength(8);
});
