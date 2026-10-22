import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startCore,
  deployment,
  encodeFrame,
  FrameDecoder,
} from "../main/core-process";
import type { CoreRequest } from "../shared/contracts";
// Script-executable adversarial children require POSIX; Windows launch is a native gate.
const subprocessIt = it.skipIf(process.platform === "win32");
const owned: ReturnType<typeof startCore>[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((core) => core.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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
 const send=value=>{const b=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));};
 process.stderr.write('SYNTHETIC_SECRET raw exception\n');fs.writeFileSync(process.argv[process.argv.indexOf('--root')+1]+'/pid',String(process.pid));if(mode==='stubborn'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);}
 process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4&&input.length>=4+input.readUInt32BE(0)){const n=input.readUInt32BE(0);const r=JSON.parse(input.subarray(4,4+n));input=input.subarray(4+n);
 if(mode==='exit'){process.exit(3);return;}
 if(mode==='partial'){process.stdout.write(Buffer.from([0]));return;}
 if(mode==='overflow'){process.stdout.write(Buffer.from([0,16,0,1]));return;}
 const result=r.method==='app.shutdown'?{status:'shutting_down'}:r.method==='reasoning.cancel'?{status:'cancelled'}:r.method==='reasoning.start'?{status:'completed',task_id:'t',text:'late',proposal:null,usage:null}:{ai_mode:'local',reasoning_backend:null};
 if(mode==='environment'&&(process.env.GITHUB_TOKEN||process.env.GH_TOKEN||process.env.NODE_OPTIONS||process.env.PYTHONPATH||process.env.PATH||process.env.HOME)) result.ai_mode='bad';
 const answer={version:['protocol','stubborn'].includes(mode)?2:1,id:r.id,kind:'response',result};
 if(mode==='late'&&r.id==='slow') setTimeout(()=>send(answer),70);else send(answer);
 if(r.method==='app.shutdown') {process.stdin.pause();process.exit(0);}
 }});process.stdin.on('end',()=>{if(mode!=='stubborn')process.exit(0);});
 `.replace("MODE", JSON.stringify(mode))}`,
  );
  await chmod(executable, 0o700);
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
  expect(
    deployment({
      packaged: false,
      projectDir: "/project",
      resourcesDir: "/resources",
      dataDir: "/state",
      platform: "darwin",
      arch: "arm64",
    }),
  ).toMatchObject({
    executable: "/project/.venv/bin/python",
    runtimePath:
      "/project/.runtime/copilot/1.0.102/prebuilds/darwin-arm64/copilot-runtime",
    pythonModule: true,
    dataDir: "/state",
  });
  expect(
    deployment({
      packaged: true,
      projectDir: "/evil",
      resourcesDir: "/resources",
      dataDir: "/state",
      platform: "win32",
      arch: "x64",
    }),
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
    const before = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "SYNTHETIC_SECRET";
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
      if (before === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = before;
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
