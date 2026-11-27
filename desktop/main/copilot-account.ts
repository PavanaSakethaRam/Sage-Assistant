/** Main-owned candidate lookup and consent. Never obtains or transports a token. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isolatedChildEnv } from "./child-env";
export type SelectedAccount = { host: "github.com"; login: string };
export type SelectionFrame = {
  version: 1;
  kind: "host_copilot_selection";
  id: string;
  boot_id: string;
  generation: number;
  account: SelectedAccount | null;
};
export type SelectionAck = {
  generation: number;
  status: "selected" | "cleared" | "unavailable";
};
export const EXECUTABLE_HASHES: Record<string, string> = {
  "darwin-arm64":
    "1ffcdcff76db02ff4f9de0fbf784ed4b6d18e434e89450db314b3f77d0f9443b",
  "darwin-x64":
    "7d209771083d0c886c0b0b88b0b6c89ed0019c8b4ae4ca40659cd1e91ebf0289",
  "win32-arm64":
    "99234015564395a1041fd0715cdf8146a467e06f8827446978e3feb9056ba4c3",
  "win32-x64":
    "8c090d7cb86e4db3cd8b969f832fe4855c2cf486ffdc35b4d2db77e164e847d1",
};
export const EXECUTABLE_SIZES: Record<string, number> = {
  "darwin-arm64": 38914960,
  "darwin-x64": 42123776,
  "win32-arm64": 38398264,
  "win32-x64": 41781560,
};
const loginShape = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid selection");
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(r, key))
  )
    throw new TypeError("Invalid selection");
  return r;
}
function generation(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError("Invalid selection");
}
export function parseSelection(value: unknown): SelectionFrame {
  const r = closed(value, [
    "version",
    "kind",
    "id",
    "boot_id",
    "generation",
    "account",
  ]);
  if (
    Buffer.byteLength(JSON.stringify(value)) > 1024 ||
    r.version !== 1 ||
    r.kind !== "host_copilot_selection" ||
    typeof r.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) ||
    typeof r.boot_id !== "string" ||
    !/^[a-f0-9]{32}$/.test(r.boot_id)
  )
    throw new TypeError("Invalid selection");
  generation(r.generation);
  if (r.account !== null) {
    const a = closed(r.account, ["host", "login"]);
    if (
      a.host !== "github.com" ||
      typeof a.login !== "string" ||
      !loginShape.test(a.login)
    )
      throw new TypeError("Invalid selection");
  }
  return value as SelectionFrame;
}
export function parseSelectionAck(value: unknown): SelectionAck {
  const r = closed(value, ["generation", "status"]);
  generation(r.generation);
  if (!["selected", "cleared", "unavailable"].includes(r.status as string))
    throw new TypeError("Invalid selection");
  return value as SelectionAck;
}
export function defaultGhConfig(
  platform: NodeJS.Platform,
  home: string,
  appData: string,
): string {
  const path =
    platform === "win32"
      ? join(appData, "GitHub CLI")
      : join(home, ".config", "gh");
  if (!isAbsolute(path)) throw new TypeError("Invalid deployment");
  return path;
}
async function noSymlinks(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new TypeError("Invalid deployment");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(current) === current) break;
  }
}
async function metadata(
  executable: string,
  root: string,
  configDir: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (![executable, root, configDir].every(isAbsolute) || signal.aborted)
    return null;
  signal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const expected = EXECUTABLE_HASHES[`${process.platform}-${process.arch}`];
  if (!expected) return null;
  try {
    await noSymlinks(executable);
    if (
      (await lstat(executable)).size !==
      EXECUTABLE_SIZES[`${process.platform}-${process.arch}`]
    )
      return null;
    if (
      createHash("sha256")
        .update(await readFile(executable, { signal }))
        .digest("hex") !== expected
    )
      return null;
    if (signal.aborted) return null;
    await noSymlinks(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      GH_CONFIG_DIR: configDir,
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_TELEMETRY: "0",
      GH_PROMPT_DISABLED: "1",
      LANG: "C.UTF-8",
    };
    for (const [key, name] of [
      ["XDG_DATA_HOME", "data"],
      ["XDG_STATE_HOME", "state"],
      ["XDG_CACHE_HOME", "cache"],
      ["TMPDIR", "tmp"],
    ]) {
      const path = join(root, name);
      await noSymlinks(path);
      await mkdir(path, { recursive: true, mode: 0o700 });
      if ((await readdir(path)).length) return null;
      env[key] = path;
    }
    env.TMP = env.TEMP = env.TMPDIR;
    const childEnv = isolatedChildEnv(env);
    if (signal.aborted) return null;
    return await new Promise<string | null>((resolve) => {
      const child = spawn(
        executable,
        ["config", "get", "user", "--host", "github.com"],
        {
          cwd: root,
          env: childEnv,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const chunks: Buffer[] = [];
      let stdout = 0,
        stderr = 0,
        failed = false,
        finished = false;
      const kill = (force: boolean) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
          else child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
          /* Owned process already exited. */
        }
      };
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const fail = () => {
        if (failed) return;
        failed = true;
        kill(false);
        escalation = setTimeout(() => kill(true), 50);
      };
      const timer = setTimeout(fail, 5000);
      signal.addEventListener("abort", fail, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.length;
        if (stdout > 8192) fail();
        else if (!failed) chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.length;
        if (stderr > 16384) fail();
      });
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        signal.removeEventListener("abort", fail);
        // The fixed config-get builtin spawns no keyring/HTTP child. POSIX also
        // closes any unexpected lingering member of this exclusively owned group.
        kill(true);
        const raw = Buffer.concat(chunks);
        chunks.length = 0;
        if (failed || signal.aborted || code !== 0) {
          resolve(null);
          return;
        }
        const value = raw.toString("ascii").replace(/\n$/, "");
        resolve(
          raw.every((b) => b < 128) && loginShape.test(value) ? value : null,
        );
      };
      child.on("error", () => {
        failed = true;
        finish(null);
      });
      child.on("close", finish);
      if (signal.aborted) fail();
    });
  } catch {
    return null;
  }
}
export class AccountBroker {
  private operation = 0;
  private active: AbortController | undefined;
  private closed = false;
  private modeTransitions = 0;
  private revocations = 0;
  private lookups = new Set<Promise<string | null>>();
  constructor(
    private readonly options: {
      executable: string;
      ownedRoot: string;
      configDir: string;
      enabled(): Promise<boolean>;
      confirm(login: string): Promise<boolean>;
      select(account: SelectedAccount | null): Promise<SelectionAck>;
    },
  ) {}
  beginModeTransition(): () => void {
    this.modeTransitions++;
    ++this.operation;
    this.active?.abort();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.modeTransitions--;
      ++this.operation;
      this.active?.abort();
    };
  }
  async choose(): Promise<{ status: SelectionAck["status"] }> {
    if (this.closed || this.modeTransitions > 0 || this.revocations > 0)
      return { status: "unavailable" };
    const operation = ++this.operation;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    try {
      if (
        !(await this.options.enabled()) ||
        operation !== this.operation ||
        this.closed
      )
        return { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
    const lookup = metadata(
      this.options.executable,
      this.options.ownedRoot,
      this.options.configDir,
      controller.signal,
    );
    this.lookups.add(lookup);
    const candidate = await lookup;
    this.lookups.delete(lookup);
    if (!candidate || operation !== this.operation || this.closed)
      return { status: "unavailable" };
    try {
      const confirmed = await this.options.confirm(candidate);
      if (!confirmed || operation !== this.operation || this.closed)
        return { status: "unavailable" };
      const ack = await this.options.select({
        host: "github.com",
        login: candidate,
      });
      return {
        status:
          operation === this.operation && !this.closed
            ? ack.status
            : "unavailable",
      };
    } catch {
      return { status: "unavailable" };
    }
  }
  async disconnect(): Promise<{ status: SelectionAck["status"] }> {
    ++this.operation;
    this.revocations++;
    this.active?.abort();
    try {
      await Promise.all([...this.lookups]);
      if (this.closed) return { status: "unavailable" };
      return { status: (await this.options.select(null)).status };
    } catch {
      return { status: "unavailable" };
    } finally {
      this.revocations--;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    ++this.operation;
    this.active?.abort();
    await Promise.all([...this.lookups]);
  }
}
