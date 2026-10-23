/** Build alias only. Never imported or selected by the production launcher. */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isolatedChildEnv } from "../../desktop/main/child-env";
import type { CoreOptions } from "../../desktop/main/core-process";
export function launchCore(options: CoreOptions) {
  const temporary = join(options.dataDir, "tmp");
  mkdirSync(temporary, { recursive: true });
  return spawn(
    resolve(
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
    ["-I", resolve("e2e/fixtures/core.py"), "--root", options.dataDir],
    {
      cwd: options.dataDir,
      env: isolatedChildEnv({
        LANG: "C.UTF-8",
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      }),
      shell: false,
      windowsHide: true,
      stdio: ["overlapped", "overlapped", "overlapped"],
    },
  );
}
