// Keep Electron's binary cache inside the project on every supported host.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL("../node_modules/electron/install.js", import.meta.url),
    ),
  ],
  {
    env: {
      ...process.env,
      electron_config_cache: fileURLToPath(
        new URL("../.cache/electron", import.meta.url),
      ),
    },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
