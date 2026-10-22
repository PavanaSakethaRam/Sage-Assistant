/** Fixed trusted child construction; the supervisor owns all lifecycle/transport. */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { CoreOptions } from "./core-process";
export function launchCore(
  options: CoreOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const temporary = join(options.dataDir, "tmp");
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    LANG: "C.UTF-8",
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
  for (const key of ["SystemRoot", "WINDIR"])
    if (process.env[key]) env[key] = process.env[key];
  const args = [
    ...(options.pythonModule ? ["-I", "-m", "sage"] : []),
    "--root",
    options.dataDir,
    ...(options.ghPath ? ["--gh-runtime", options.ghPath] : []),
    ...(options.runtimePath ? ["--copilot-runtime", options.runtimePath] : []),
  ];
  const child = spawn(options.executable, args, {
    cwd: options.dataDir,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["overlapped", "overlapped", "overlapped"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  return child;
}
