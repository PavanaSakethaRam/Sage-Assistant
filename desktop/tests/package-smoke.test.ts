import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";

type Record = {
  pid: number;
  root: string;
  cwd: string;
  phase: "metadata" | "sdk" | "rpc";
  args: string[];
};
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
    const reachedPath = join(root, "reached.txt");
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
const args = process.argv.slice(2);
const phase = args[0] === '--self-check' ? 'metadata' : args[0] === '--sdk-self-check' ? 'sdk' : 'rpc';
const state = phase === 'rpc' ? args[1] : process.cwd();
fs.appendFileSync(${JSON.stringify(recordsPath)}, JSON.stringify({pid: process.pid, root: state, cwd: process.cwd(), phase, args})+'\\n');
const mode = ${JSON.stringify(mode)};
function reached() { fs.appendFileSync(${JSON.stringify(reachedPath)}, mode+'\\n'); }
function frame(value) { const body = Buffer.from(JSON.stringify(value)); const h = Buffer.alloc(4); h.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([h,body])); }
if (phase === 'metadata') frame({
 schema:1, python:'3.13.17 (synthetic)', openssl:'OpenSSL 3', sqlite:'3.50',
 sdk:'1.0.25', certifi:'2026.10.19', frozen:true, ssl_module:'_ssl', bundle:'synthetic',
 trust:{verify_mode:2,check_hostname:true,verify_flags:4,store:{x509:0,x509_ca:0,crl:0},
 default_paths:{cafile:null,capath:null,openssl_cafile_env:'SSL_CERT_FILE',openssl_cafile:'cert.pem',openssl_capath_env:'SSL_CERT_DIR',openssl_capath:'certs'},
 cafile_exists:false,capath_exists:false},
 environment_overrides:{SSL_CERT_FILE:false,SSL_CERT_DIR:false,SSLKEYLOGFILE:false,HTTPS_PROXY:false,ALL_PROXY:false}
});
else if (phase === 'sdk') frame({schema:1,status:'pass',stage:'complete',category:'none',sdk:'1.0.25',python:'3.13.17',frozen:true});
else {
 if (['oversized','malformed','stream-end','shutdown-hang'].includes(mode)) process.on('SIGTERM', () => {});
 if (mode === 'early-exit') { reached(); process.exit(7); }
 else if (mode === 'signal-exit') { reached(); process.kill(process.pid,'SIGTERM'); }
 else if (mode === 'oversized') { reached(); const h=Buffer.alloc(4);h.writeUInt32BE(1048577);process.stdout.write(h); }
 else if (mode === 'malformed') { reached(); process.stdout.write(Buffer.from([0,0,0,1,123])); }
 else if (mode === 'stream-end') { reached(); process.stdout.end(); }
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
   if(request.method==='app.shutdown' && mode==='shutdown-hang') reached();
   if(request.method==='app.shutdown' && mode==='shutdown-malformed') { reached(); process.stdout.write(Buffer.from([0,0,0,1,123])); process.exit(0); }
   if(request.method==='app.shutdown' && mode==='success') { reached(); process.exit(0); }
  }
 });
 setInterval(()=>{},1000);
}
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
        expect(records.map((record) => record.phase)).toEqual(
          mode === "success"
            ? ["metadata", "sdk", "rpc", "rpc"]
            : ["metadata", "sdk", "rpc"],
        );
        const ownedRoot = records[0].root;
        expect(basename(ownedRoot).startsWith("sage-package-")).toBe(true);
        expect(await realpath(dirname(ownedRoot))).toBe(await realpath(root));
        for (const [index, record] of records.entries()) {
          expect(basename(record.root)).toBe(basename(ownedRoot));
          expect(await realpath(dirname(record.root))).toBe(
            await realpath(dirname(ownedRoot)),
          );
          expect(basename(record.cwd)).toBe(basename(ownedRoot));
          expect(await realpath(dirname(record.cwd))).toBe(
            await realpath(dirname(ownedRoot)),
          );
          expect(record.args).toEqual(
            index === 0
              ? ["--self-check"]
              : index === 1
                ? ["--sdk-self-check"]
                : ["--root", record.root],
          );
        }
        expect(
          (await readFile(reachedPath, "utf8")).trim().split("\n"),
        ).toEqual(mode === "success" ? ["success", "success"] : [mode]);
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
      if (mode === "success") {
        expect(output).toContain('"offline_metadata_probe":true');
        expect(output).toContain('"offline_sdk_construction_probe":true');
      }
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
