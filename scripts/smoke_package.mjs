/** Actual frozen-core note/restart smoke, with no developer Python or PATH. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function deadline(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Package shutdown timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function fail(session, message) {
  session.failure ??= Error(message);
  for (const request of session.pending.values()) {
    clearTimeout(request.timer);
    request.reject(session.failure);
  }
  session.pending.clear();
}

function launch(resources, root, env) {
  const child = spawn(
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
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  let resolveClose;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const session = {
    child,
    exited,
    closed,
    exit: undefined,
    pending: new Map(),
    failure: undefined,
    expectedExit: false,
  };
  function finish(code, signal) {
    if (session.exit) return;
    session.exit = { code, signal };
    resolveExit(session.exit);
  }
  // Attach before any request. Spawn failures may have no pid/exit event.
  child.once("exit", finish);
  child.once("error", () => {
    fail(session, "Package core spawn failed");
    if (child.pid === undefined) finish(null, null);
  });
  child.once("close", (code, signal) => {
    finish(code, signal);
    if (session.pending.size || !session.expectedExit)
      fail(session, "Package core exited before response");
    resolveClose(session.exit);
  });
  for (const stream of [child.stdin, child.stdout, child.stderr])
    stream.on("error", () => fail(session, "Package core stream failed"));
  child.stderr.resume();
  child.stdout.on("end", () => {
    if (session.pending.size || !session.expectedExit)
      fail(session, "Package core response stream ended");
  });
  let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    if (session.failure) return;
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE();
        if (!size || size > 1048576) throw Error("Invalid frame length");
        if (buffer.length < size + 4) return;
        const value = JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
        buffer = buffer.subarray(size + 4);
        if (!value || typeof value !== "object" || typeof value.id !== "string")
          throw Error("Invalid response");
        const pending = session.pending.get(value.id);
        if (!pending) throw Error("Unexpected response");
        session.pending.delete(value.id);
        clearTimeout(pending.timer);
        pending.resolve(value);
      }
    } catch {
      // Event callbacks settle the awaited path; never throw past finally.
      fail(session, "Invalid package response frame");
    }
  });
  return session;
}

let sequence = 0;
async function request(session, method, params = {}) {
  if (session.failure) throw session.failure;
  if (session.exit) throw Error("Package core already exited");
  const id = `package_${++sequence}`;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(session, "Package RPC timeout"), 10000);
    session.pending.set(id, { resolve, reject, timer });
  });
  const body = Buffer.from(
    JSON.stringify({ version: 1, kind: "request", id, method, params }),
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  try {
    session.child.stdin.write(Buffer.concat([header, body]), (error) => {
      if (error) fail(session, "Package core write failed");
    });
  } catch {
    fail(session, "Package core write failed");
  }
  const value = await response;
  if (session.failure) throw session.failure;
  if (value.kind !== "response") throw Error("Package RPC failure");
  return value.result;
}

async function close(session) {
  session.expectedExit = true;
  await request(session, "app.shutdown");
  session.child.stdin.end();
  // close also waits for trailing stdout callbacks after the exit event.
  const { code, signal } = await deadline(session.closed, 3000);
  if (session.failure) throw session.failure;
  if (code !== 0 || signal !== null)
    throw Error("Package core shutdown failed");
}

async function cleanup(session) {
  if (!session) return;
  fail(session, "Package smoke closing");
  for (const stream of [
    session.child.stdin,
    session.child.stdout,
    session.child.stderr,
  ])
    stream.destroy();
  if (session.exit) return;
  session.child.kill("SIGTERM");
  try {
    await deadline(session.exited, 500);
  } catch {
    session.child.kill("SIGKILL");
    await deadline(session.exited, 1500);
  }
}

async function main() {
  const resources = resolve(process.argv[2]);
  const root = await mkdtemp(join(tmpdir(), "sage-package-"));
  let session;
  try {
    await mkdir(join(root, "tmp"));
    const env = {
      LANG: "C.UTF-8",
      TMPDIR: join(root, "tmp"),
      TMP: join(root, "tmp"),
      TEMP: join(root, "tmp"),
    };
    for (const key of ["SystemRoot", "WINDIR"])
      if (process.env[key]) env[key] = process.env[key];
    session = launch(resources, root, env);
    const settings = await request(session, "settings.get");
    if (settings.ai_mode !== "local") throw Error("Unexpected package default");
    const draft = await request(session, "notes.propose", {
      title: "Synthetic package note",
      body: "Synthetic local persistence smoke.",
    });
    const saved = await request(session, "notes.decide", {
      proposal_id: draft.id,
      revision: draft.revision,
      decision: "save",
    });
    if (saved.status !== "succeeded") throw Error("Package note save failed");
    await close(session);
    session = launch(resources, root, env);
    const note = await request(session, "notes.get", {
      note_id: saved.note_id,
    });
    if (
      note.title !== "Synthetic package note" ||
      note.body !== "Synthetic local persistence smoke."
    )
      throw Error("Package restart persistence failed");
    const unavailable = await request(session, "connection.test");
    if (unavailable.status !== "unavailable")
      throw Error("Unexpected local inference");
    await close(session);
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
    try {
      await cleanup(session);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
await main().catch(() => {
  console.error("FAIL package smoke");
  process.exitCode = 1;
});
