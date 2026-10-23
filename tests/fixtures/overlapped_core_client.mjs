// Windows integration fixture: Node gives the child the same overlapped stdio
// handles as the desktop host. Only synthetic, fixed requests are sent.
import { spawn } from "node:child_process";
import { createStderrSummary } from "./stderr_summary.mjs";

const [python, source, root, scenario] = process.argv.slice(2);
if (
  !python ||
  !source ||
  !root ||
  !["shutdown", "invalid"].includes(scenario)
) {
  process.exit(2);
}
const child = spawn(python, ["-m", "sage", "--root", root], {
  env: { ...process.env, PYTHONPATH: source },
  stdio: ["overlapped", "overlapped", "overlapped"],
  windowsHide: true,
  shell: false,
});
const closed = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
const stop = () => {
  if (child.exitCode === null && child.signalCode === null) child.kill();
};
process.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(1);
  });
}
const deadline = setTimeout(stop, 10_000);
let bytes = Buffer.alloc(0);
const stderrSummary = createStderrSummary();
const frames = [];
let wake;
child.stdout.on("data", (part) => {
  bytes = Buffer.concat([bytes, part]);
  while (bytes.length >= 4) {
    const size = bytes.readUInt32BE(0);
    if (size < 1 || size > 1_048_576 || bytes.length < size + 4) break;
    frames.push(JSON.parse(bytes.subarray(4, size + 4).toString("utf8")));
    bytes = bytes.subarray(size + 4);
    wake?.();
  }
});
child.stderr.on("data", (part) => {
  stderrSummary.push(part);
});
function nextFrame(count) {
  if (frames.length >= count) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frame_timeout")), 5_000);
    wake = () => {
      if (frames.length >= count) {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
    };
  });
}
function request(id, method, params) {
  const body = Buffer.from(
    JSON.stringify({
      version: 1,
      id,
      kind: "request",
      method,
      params,
    }),
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  child.stdin.write(Buffer.concat([prefix, body]));
}
try {
  if (scenario === "shutdown") {
    request("p", "notes.propose", { title: "Title", body: "Body" });
    await nextFrame(1);
    request("shutdown", "app.shutdown", {});
    await nextFrame(2);
    child.stdin.end();
  } else {
    const body = Buffer.from('{"secret":"SYNTHETIC_SECRET",broken}');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(body.length);
    child.stdin.end(Buffer.concat([prefix, body]));
    await nextFrame(1);
  }
  const code = await closed;
  process.stdout.write(
    JSON.stringify({
      code,
      frames,
      trailingBytes: bytes.length,
      ...stderrSummary.result(),
    }),
  );
} catch (error) {
  stop();
  process.stderr.write(
    error instanceof Error ? error.message : "fixture_failed",
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
