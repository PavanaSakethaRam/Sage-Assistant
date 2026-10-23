import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

type Record = { pid: number; root: string };
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return true;
  }
}

const subprocessTest = test.skipIf(process.platform === "win32");
subprocessTest.each([
  "oversized",
  "malformed",
  "early-exit",
  "signal-exit",
  "stream-end",
  "spawn-error",
  "shutdown-hang",
  "shutdown-malformed",
  "success",
])(
  "real package smoke reaps %s and removes its owned root",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "sage-smoke-regression-"));
    const recordsPath = join(root, "children.jsonl");
    const resources = join(root, "resources");
    const executable = join(resources, "core/sage-core");
    let smoke: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let records: Record[] = [];
    try {
      await mkdir(join(resources, "core"), { recursive: true });
      if (mode !== "spawn-error") {
        await writeFile(
          executable,
          `#!${process.execPath}
const fs = require('node:fs');
const state = process.argv[process.argv.indexOf('--root') + 1];
fs.appendFileSync(${JSON.stringify(recordsPath)}, JSON.stringify({pid: process.pid, root: state})+'\\n');
const mode = ${JSON.stringify(mode)};
if (['oversized','malformed','stream-end','shutdown-hang'].includes(mode)) process.on('SIGTERM', () => {});
function frame(value) { const body = Buffer.from(JSON.stringify(value)); const h = Buffer.alloc(4); h.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([h,body])); }
if (mode === 'early-exit') process.exit(7);
else if (mode === 'signal-exit') process.kill(process.pid,'SIGTERM');
else if (mode === 'oversized') { const h=Buffer.alloc(4);h.writeUInt32BE(1048577);process.stdout.write(h); }
else if (mode === 'malformed') process.stdout.write(Buffer.from([0,0,0,1,123]));
else if (mode === 'stream-end') process.stdout.end();
else {
 let buffer=Buffer.alloc(0);
 process.stdin.on('data', chunk => {
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4) {
   const n=buffer.readUInt32BE();if(buffer.length<n+4)return;
   const request=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);
   let result={};
   if(request.method==='settings.get')result={ai_mode:'local'};
   if(request.method==='notes.propose')result={id:'synthetic',revision:1};
   if(request.method==='notes.decide')result={status:'succeeded',note_id:'synthetic'};
   if(request.method==='notes.get')result={title:'Synthetic package note',body:'Synthetic local persistence smoke.'};
   if(request.method==='connection.test')result={status:'unavailable'};
   frame({version:1,kind:'response',id:request.id,result});
   if(request.method==='app.shutdown' && mode==='shutdown-malformed') { process.stdout.write(Buffer.from([0,0,0,1,123])); process.exit(0); }
   if(request.method==='app.shutdown' && mode==='success')process.exit(0);
  }
 });
}
setInterval(()=>{},1000);
`,
        );
        await chmod(executable, 0o700);
      }
      smoke = spawn(
        process.execPath,
        [resolve("scripts/smoke_package.mjs"), resources],
        {
          env: { LANG: "C.UTF-8", TMPDIR: root, TMP: root, TEMP: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      smoke.stdout?.on("data", (data) => {
        output += String(data);
      });
      smoke.stderr?.resume();
      const result = await new Promise<{
        code: number | null;
        timedOut: boolean;
      }>((done, reject) => {
        let timedOut = false;
        timer = setTimeout(() => {
          timedOut = true;
          smoke?.kill("SIGKILL");
        }, 7000);
        smoke!.once("error", reject);
        smoke!.once("close", (code) => done({ code, timedOut }));
      });
      clearTimeout(timer);
      if (mode !== "spawn-error") {
        records = (await readFile(recordsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record);
        expect(records.length).toBe(mode === "success" ? 2 : 1);
        for (const record of records) {
          expect(gone(record.pid), "synthetic child still alive").toBe(true);
          await expect(access(record.root)).rejects.toThrow();
        }
      }
      expect(
        result.timedOut,
        "smoke failed to settle within its bounded cleanup",
      ).toBe(false);
      expect(result.code).toBe(mode === "success" ? 0 : 1);
      expect(
        (await readdir(root)).filter((name) =>
          name.startsWith("sage-package-"),
        ),
      ).toEqual([]);
      if (mode === "success")
        expect(output).toContain('"frozen_note_restart":true');
    } finally {
      clearTimeout(timer);
      if (smoke && smoke.exitCode === null && smoke.signalCode === null)
        smoke.kill("SIGKILL");
      try {
        records = (await readFile(recordsPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record);
      } catch {
        /* Spawn-error case has no child record. */
      }
      for (const record of records)
        if (!gone(record.pid)) process.kill(record.pid, "SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  },
  12000,
);
