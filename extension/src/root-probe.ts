/** Fixed installed helper, never a model-selected executable or command surface. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { isolatedChildEnv } from "../../desktop/main/child-env";
declare const __SAGE_ROOT_PROBE_SHA256__: string;
function invalid(): never {
  throw Error("Local root unavailable");
}
export function validateRootSpelling(
  root: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    !root ||
    Buffer.byteLength(root, "utf8") > 16384 ||
    /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(root)
  )
    invalid();
  if (platform === "darwin") {
    if (
      !root.startsWith("/") ||
      root.startsWith("//") ||
      (root !== "/" &&
        (root.endsWith("/") ||
          root
            .split("/")
            .slice(1)
            .some((p) => !p || p === "." || p === "..")))
    )
      invalid();
  } else if (platform === "win32") {
    if (
      !/^[A-Z]:\\/u.test(root) ||
      /[/:~]/u.test(root.slice(3)) ||
      root
        .slice(3)
        .split("\\")
        .some((p) => !p || p === "." || p === ".." || /[. ]$/u.test(p))
    )
      invalid();
  } else invalid();
}
export function parseRootProbe(
  output: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const match =
    /^SAGE_ROOT_V1 (darwin|win32) (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,19})\n$/u.exec(
      output,
    );
  if (
    !match ||
    match[1] !== platform ||
    BigInt(match[2]) > 18446744073709551615n ||
    BigInt(match[3]) > 18446744073709551615n
  )
    invalid();
  return `${match[1]}-${match[2]}-${match[3]}`;
}
export async function probeRoot(
  root: string,
  extensionPath: string,
  storagePath: string,
  guard: () => void,
): Promise<string> {
  guard();
  validateRootSpelling(root);
  const name =
    process.platform === "darwin" && process.arch === "arm64"
      ? "root-probe-darwin-arm64"
      : process.platform === "win32" && process.arch === "x64"
        ? "root-probe-win32-x64.exe"
        : invalid();
  if (
    typeof __SAGE_ROOT_PROBE_SHA256__ !== "string" ||
    !isAbsolute(extensionPath) ||
    !isAbsolute(storagePath)
  )
    invalid();
  const executable = join(extensionPath, "dist", name);
  const info = await lstat(executable);
  guard();
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 1048576
  )
    invalid();
  const handle = await open(
    executable,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    guard();
    const buffer = Buffer.alloc(1048577);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      guard();
      length += read.bytesRead;
      if (!read.bytesRead) break;
    }
    if (length > 1048576) invalid();
    const bytes = buffer.subarray(0, length);
    guard();
    if (
      createHash("sha256").update(bytes).digest("hex") !==
      __SAGE_ROOT_PROBE_SHA256__
    )
      invalid();
  } finally {
    await handle.close();
  }
  guard();
  const temporary = await mkdtemp(join(storagePath, "probe-"));
  try {
    guard();
    if ((await realpath(executable)) !== executable) invalid();
    guard();
    const env = isolatedChildEnv(
      {
        PATH: "",
        TEMP: temporary,
        TMP: temporary,
        TMPDIR: temporary,
        ...(process.platform === "win32" ? { HOME: "" } : {}),
      },
      process.platform,
      process.platform === "win32" ? process.env : {},
    );
    if (process.platform === "win32") {
      if (
        !/^[A-Za-z]:\\[^\u0000-\u001f]+$/u.test(env.SystemRoot ?? "") ||
        env.WINDIR !== env.SystemRoot ||
        !/^([A-Za-z]:)$/u.test(env.SystemDrive ?? "")
      )
        invalid();
    }
    guard();
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ["--check-root-v1"], {
        shell: false,
        detached: false,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = Buffer.alloc(0),
        stderr = 0,
        failed = false,
        settled = false;
      let force: ReturnType<typeof setTimeout> | undefined,
        observe: ReturnType<typeof setTimeout> | undefined;
      const finish = (value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (force) clearTimeout(force);
        if (observe) clearTimeout(observe);
        child.removeAllListeners();
        child.stdout.removeAllListeners("data");
        child.stderr.removeAllListeners("data");
        if (value === undefined) reject(Error("Local root unavailable"));
        else resolve(value);
      };
      const fail = () => {
        if (failed) return;
        failed = true;
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        force = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        }, 2000);
        observe = setTimeout(() => finish(), 5000);
      };
      const timer = setTimeout(fail, 2000);
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stdout.on("data", (bytes: Buffer) => {
        if (stdout.length + bytes.length > 1024) fail();
        else stdout = Buffer.concat([stdout, bytes]);
      });
      child.stderr.on("data", (bytes: Buffer) => {
        stderr += bytes.length;
        if (stderr > 1024) fail();
      });
      child.on("close", (code) => {
        try {
          guard();
          if (
            failed ||
            code !== 0 ||
            stderr ||
            stdout.some((byte) => byte > 127)
          )
            invalid();
          finish(parseRootProbe(stdout.toString("ascii")));
        } catch {
          finish();
        }
      });
      child.stdin.end(Buffer.from(root, "utf8"));
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
