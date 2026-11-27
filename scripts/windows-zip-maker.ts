/** Forge's Windows ZIP path uses the public maker API and a fixed local script. */
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MakerZIP } from "@electron-forge/maker-zip";

const script = fileURLToPath(new URL("./windows-zip.ps1", import.meta.url));
type Launch = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export function createWindowsZip(
  source: string,
  destination: string,
  launch: Launch = spawn,
  timeoutMs = 120_000,
): Promise<void> {
  return new Promise((resolveDone, rejectDone) => {
    const child = launch(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Source",
        source,
        "-Destination",
        destination,
      ],
      { shell: false, windowsHide: true, stdio: "ignore" },
    );
    let settled = false;
    const finish = (code?: "start" | "exit" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code) rejectDone(new Error(`Windows ZIP creation failed: ${code}`));
      else resolveDone();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish("timeout");
    }, timeoutMs);
    child.once("error", () => finish("start"));
    child.once("close", (code) => finish(code === 0 ? undefined : "exit"));
  });
}

export class WindowsSafeMakerZIP extends MakerZIP {
  override async make(
    options: Parameters<MakerZIP["make"]>[0],
  ): Promise<string[]> {
    if (options.targetPlatform !== "win32") return super.make(options);
    const zipName = `${basename(options.dir)}-${options.packageJSON.version}.zip`;
    const zipPath = resolve(
      options.makeDir,
      "zip",
      options.targetPlatform,
      options.targetArch,
      zipName,
    );
    await this.ensureFile(zipPath);
    await createWindowsZip(options.dir, zipPath);
    return [zipPath];
  }
}
