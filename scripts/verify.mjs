import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const python = resolve(
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const result = spawnSync(
  python,
  ["scripts/verify.py", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      UV_CACHE_DIR: resolve(".cache/uv"),
      npm_config_cache: resolve(".cache/npm"),
    },
  },
);
process.exit(result.status ?? 1);
