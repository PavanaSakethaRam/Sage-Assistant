/** Actual frozen-core note/restart smoke, with no developer Python or PATH. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
const resources = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "sage-package-"));
await mkdir(join(root, "tmp"));
const env = {
  LANG: "C.UTF-8",
  TMPDIR: join(root, "tmp"),
  TMP: join(root, "tmp"),
  TEMP: join(root, "tmp"),
};
for (const key of ["SystemRoot", "WINDIR"])
  if (process.env[key]) env[key] = process.env[key];
let child;
let sequence = 0;
const pending = new Map();
function launch() {
  let buffer = Buffer.alloc(0);
  child = spawn(
    join(
      resources,
      "core",
      process.platform === "win32" ? "sage-core.exe" : "sage-core",
    ),
    ["--root", root],
    {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["overlapped", "overlapped", "overlapped"],
    },
  );
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32BE();
      if (size > 1048576) throw Error("Oversized package frame");
      if (buffer.length < size + 4) return;
      const value = JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
      buffer = buffer.subarray(size + 4);
      pending.get(value.id)?.(value);
      pending.delete(value.id);
    }
  });
}
async function request(method, params = {}) {
  const id = `package_${++sequence}`;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Package RPC timeout")), 10000);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
  const body = Buffer.from(
    JSON.stringify({ version: 1, kind: "request", id, method, params }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
  const value = await response;
  if (value.kind !== "response") throw Error("Package RPC failure");
  return value.result;
}
async function close() {
  const exited = once(child, "exit");
  await request("app.shutdown");
  child.stdin.end();
  const [code] = await exited;
  if (code !== 0) throw Error("Package core shutdown failed");
}
try {
  launch();
  const settings = await request("settings.get");
  if (settings.ai_mode !== "local") throw Error("Unexpected package default");
  const draft = await request("notes.propose", {
    title: "Synthetic package note",
    body: "Synthetic local persistence smoke.",
  });
  const saved = await request("notes.decide", {
    proposal_id: draft.id,
    revision: draft.revision,
    decision: "save",
  });
  if (saved.status !== "succeeded") throw Error("Package note save failed");
  await close();
  launch();
  const note = await request("notes.get", { note_id: saved.note_id });
  if (
    note.title !== "Synthetic package note" ||
    note.body !== "Synthetic local persistence smoke."
  )
    throw Error("Package restart persistence failed");
  const unavailable = await request("connection.test");
  if (unavailable.status !== "unavailable")
    throw Error("Unexpected local inference");
  await close();
  console.log(
    JSON.stringify({
      status: "PASS",
      frozen_note_restart: true,
      local_inference_unavailable: true,
      developer_python: false,
      path_environment: false,
      cloud_calls: 0,
    }),
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
  }
  await rm(root, { recursive: true, force: true });
}
