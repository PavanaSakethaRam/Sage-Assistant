/** Fixed owned child; framed stdout only, redacted stderr, no replay after failure. */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  parseSelection,
  parseSelectionAck,
  type SelectedAccount,
  type SelectionFrame,
  type SelectionAck,
} from "./copilot-account";
import {
  MAX_FRAME_BYTES,
  failure,
  parseRequest,
  parseResponse,
  parseProgress,
  type CoreRequest,
  type CoreResponse,
  type Progress,
} from "../shared/contracts";
export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (!body.length || body.length > MAX_FRAME_BYTES)
    throw new TypeError("Invalid frame");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(body.length);
  return Buffer.concat([prefix, body]);
}
function decode(body: Buffer): Record<string, unknown> {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(body);
  const value: unknown = JSON.parse(text);
  // JSON.parse alone accepts duplicate keys. Scan already-valid JSON tokens, retaining
  // one key set per object, so escaped duplicate names fail just like Python's pairs hook.
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (const token of text.matchAll(
    /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/gu,
  )) {
    const word = token[0];
    const top = stack.at(-1);
    if (word === "{") stack.push({ keys: new Set(), key: true });
    else if (word === "[") stack.push(null);
    else if (word === "}" || word === "]") stack.pop();
    else if (word === "," && top) top.key = true;
    else if (word.startsWith('"') && top?.key) {
      const key = JSON.parse(word) as string;
      if (top.keys.has(key)) throw new TypeError("Invalid frame");
      top.keys.add(key);
      top.key = false;
    }
  }
  function walk(item: unknown, depth: number): void {
    if (depth > 32) throw new TypeError("Invalid frame");
    if (typeof item === "string" && /[\uD800-\uDFFF]/u.test(item))
      throw new TypeError("Invalid frame");
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        if (/[\uD800-\uDFFF]/u.test(key)) throw new TypeError("Invalid frame");
        walk(child, depth + 1);
      }
    }
  }
  walk(value, 0);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid frame");
  return value as Record<string, unknown>;
}
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  get incomplete(): boolean {
    return this.buffer.length > 0;
  }
  push(chunk: Buffer): Record<string, unknown>[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: Record<string, unknown>[] = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0);
      if (!size || size > MAX_FRAME_BYTES) throw new TypeError("Invalid frame");
      if (this.buffer.length < size + 4) break;
      messages.push(decode(this.buffer.subarray(4, size + 4)));
      this.buffer = this.buffer.subarray(size + 4);
    }
    return messages;
  }
}
export type CoreOptions = {
  executable: string;
  dataDir: string;
  runtimePath?: string;
  ghPath?: string;
  pythonModule?: boolean;
};
export function deployment(options: {
  packaged: boolean;
  projectDir: string;
  resourcesDir: string;
  dataDir: string;
  platform: NodeJS.Platform;
  arch?: string;
}): CoreOptions {
  const windows = options.platform === "win32";
  const arch = options.arch ?? process.arch;
  if (
    !["darwin", "win32", "linux"].includes(options.platform) ||
    !["arm64", "x64"].includes(arch)
  )
    throw new TypeError("Unsupported deployment");
  return {
    executable: options.packaged
      ? join(
          options.resourcesDir,
          "core",
          windows ? "sage-core.exe" : "sage-core",
        )
      : join(
          options.projectDir,
          ".venv",
          windows ? "Scripts" : "bin",
          windows ? "python.exe" : "python",
        ),
    dataDir: options.dataDir,
    pythonModule: !options.packaged,
    ghPath: join(
      options.packaged
        ? options.resourcesDir
        : join(options.projectDir, ".runtime"),
      "gh",
      "2.103.0",
      `${options.platform}-${arch}`,
      "bin",
      windows ? "gh.exe" : "gh",
    ),
    runtimePath: join(
      options.packaged
        ? options.resourcesDir
        : join(options.projectDir, ".runtime"),
      "copilot",
      "1.0.102",
      "prebuilds",
      `${options.platform}-${arch}`,
      windows ? "copilot-runtime.exe" : "copilot-runtime",
    ),
  };
}
// Up to eight sequential public aborts (8*3s), then parallel per-session
// abort/disconnect/stop/force-stop (3+3+5+10s), pipe close (5s), 10s headroom.
// EOF normally cancels provider work in parallel sooner. The host keeps draining.
const SHUTDOWN_GRACE_MS = 60_000;
type Child = ChildProcessByStdio<Writable, Readable, Readable>;
type SelectionResponse = {
  version: 1;
  kind: "response";
  id: string;
  result: SelectionAck;
};
type Terminal = CoreResponse | SelectionResponse;
type Pending = {
  request: CoreRequest | SelectionFrame;
  resolve: (response: Terminal) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class CoreProcess {
  private child: Child | undefined;
  private closed = false;
  private children = new Set<Child>();
  private seen = new Set<string>();
  private discarded = new Set<string>();
  private pending = new Map<string, Pending>();
  private handlers = new Set<(progress: Progress) => void>();
  private _launches = 0;
  private bootId = "";
  private generation = 0;
  constructor(private readonly options: CoreOptions) {
    if (
      !isAbsolute(options.executable) ||
      !isAbsolute(options.dataDir) ||
      (options.runtimePath !== undefined && !isAbsolute(options.runtimePath)) ||
      (options.ghPath !== undefined && !isAbsolute(options.ghPath))
    )
      throw new TypeError("Invalid core deployment");
  }
  private launch(): Child | undefined {
    if (this.child) return this.child;
    if (this.closed || this._launches >= 2) return undefined;
    this._launches++;
    this.bootId = randomUUID().replaceAll("-", "");
    this.generation = 0;
    mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.dataDir, "tmp");
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
      ...(this.options.pythonModule ? ["-I", "-m", "sage"] : []),
      "--root",
      this.options.dataDir,
      ...(this.options.ghPath ? ["--gh-runtime", this.options.ghPath] : []),
      ...(this.options.runtimePath
        ? ["--copilot-runtime", this.options.runtimePath]
        : []),
    ];
    const child = spawn(this.options.executable, args, {
      cwd: this.options.dataDir,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["overlapped", "overlapped", "overlapped"],
    }) as Child;
    this.child = child;
    this.children.add(child);
    const decoder = new FrameDecoder();
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      if (frameTimer) clearTimeout(frameTimer);
      if (this.child === child) {
        this.child = undefined;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve(failure(id, "internal_error"));
        }
        this.pending.clear();
      }
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const reap = setTimeout(() => child.kill("SIGKILL"), 1000);
        child.once("close", () => clearTimeout(reap));
      }
    };
    child.stderr.on("data", () => {
      /* Never relay child diagnostics or exception strings. */
    });
    child.stderr.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.on("error", stop);
    child.on("close", () => {
      this.children.delete(child);
      stop();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          const identifier = message.id;
          if (typeof identifier !== "string")
            throw new TypeError("Invalid response");
          if (this.discarded.has(identifier)) continue;
          const p = this.pending.get(identifier);
          if (!p) throw new TypeError("Invalid response");
          if (message.kind === "progress") {
            const progress = parseProgress(message);
            if (
              p.request.kind !== "request" ||
              p.request.method !== "reasoning.start"
            )
              throw new TypeError("Invalid progress");
            for (const handler of this.handlers) {
              try {
                handler(progress);
              } catch {
                /* Subscriber failures do not own transport. */
              }
            }
            continue;
          }
          let response: Terminal;
          if (
            p.request.kind === "host_copilot_selection" &&
            message.kind === "response"
          ) {
            if (
              Object.keys(message).sort().join(",") !==
                "id,kind,result,version" ||
              message.version !== 1
            )
              throw new TypeError("Invalid selection response");
            const ack = parseSelectionAck(message.result);
            if (ack.generation !== p.request.generation)
              throw new TypeError("Invalid selection response");
            response = {
              version: 1,
              kind: "response",
              id: identifier,
              result: ack,
            };
          } else
            response = parseResponse(
              message,
              p.request.kind === "request" ? p.request.method : "settings.get",
            );
          if (response.id !== identifier)
            throw new TypeError("Invalid response");
          clearTimeout(p.timer);
          this.pending.delete(identifier);
          p.resolve(response);
        }
        if (!decoder.incomplete && frameTimer) {
          clearTimeout(frameTimer);
          frameTimer = undefined;
        } else if (decoder.incomplete && !frameTimer)
          frameTimer = setTimeout(stop, 30000);
      } catch {
        stop();
      }
    });
    return child;
  }
  request(value: CoreRequest): Promise<CoreResponse> {
    const request = parseRequest(value);
    if (
      ["external.open", "copilot.chooseAccount", "copilot.disconnect"].includes(
        request.method,
      )
    )
      return Promise.resolve(failure(request.id, "invalid_request"));
    return this.send(request) as Promise<CoreResponse>;
  }
  async selectAccount(account: SelectedAccount | null): Promise<SelectionAck> {
    if (!this.launch()) throw new TypeError("Core unavailable");
    const response = await this.send(
      parseSelection({
        version: 1,
        kind: "host_copilot_selection",
        id: randomUUID(),
        boot_id: this.bootId,
        generation: ++this.generation,
        account,
      }),
    );
    if (response.kind !== "response")
      throw new TypeError("Selection unavailable");
    return parseSelectionAck(response.result);
  }
  private send(request: CoreRequest | SelectionFrame): Promise<Terminal> {
    if (this.closed)
      return Promise.resolve(failure(request.id, "shutting_down"));
    if (this.seen.has(request.id))
      return Promise.resolve(failure(request.id, "duplicate_id"));
    if (this.seen.size >= 4096)
      return Promise.resolve(failure(request.id, "session_limit"));
    this.seen.add(request.id);
    if (this.pending.size >= 8)
      return Promise.resolve(failure(request.id, "busy"));
    const child = this.launch();
    if (!child) return Promise.resolve(failure(request.id, "internal_error"));
    if (
      request.kind === "request" &&
      request.method === "reasoning.cancel" &&
      this.pending.get(request.params.request_id)?.request.kind === "request" &&
      (this.pending.get(request.params.request_id)?.request as CoreRequest)
        .method === "reasoning.start"
    )
      this.invalidate(request.params.request_id, "cancelled");
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.invalidate(request.id, "timeout");
          if (
            request.kind === "request" &&
            request.method === "reasoning.start"
          )
            void this.cancel(request.id);
        },
        request.kind === "request" ? (request.timeout_ms ?? 30000) : 30000,
      );
      this.pending.set(request.id, { request, resolve, timer });
      try {
        child.stdin.write(encodeFrame(request));
      } catch {
        this.invalidate(request.id, "internal_error");
        child.kill();
      }
    });
  }
  private invalidate(
    identifier: string,
    code: "cancelled" | "timeout" | "internal_error",
  ): void {
    const p = this.pending.get(identifier);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(identifier);
      this.discarded.add(identifier);
      p.resolve(failure(identifier, code));
    }
  }
  cancel(requestId: string): Promise<CoreResponse> {
    return this.request({
      version: 1,
      id: randomUUID(),
      kind: "request",
      method: "reasoning.cancel",
      params: { request_id: requestId },
    });
  }
  onProgress(handler: (progress: Progress) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  private closing: Promise<void> | undefined;
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.handlers.clear();
    this.closing = (async () => {
      for (const id of this.pending.keys()) this.invalidate(id, "cancelled");
      await Promise.all(
        [...this.children].map(
          (child) =>
            new Promise<void>((resolve) => {
              const killTimer = setTimeout(() => {
                child.kill("SIGKILL");
              }, SHUTDOWN_GRACE_MS);
              child.once("close", () => {
                clearTimeout(killTimer);
                resolve();
              });
              try {
                const shutdown = randomUUID();
                this.discarded.add(shutdown);
                child.stdin.end(
                  encodeFrame({
                    version: 1,
                    id: shutdown,
                    kind: "request",
                    method: "app.shutdown",
                    params: {},
                  }),
                );
              } catch {
                child.kill();
              }
            }),
        ),
      );
    })();
    return this.closing;
  }
}
export function startCore(options: CoreOptions): CoreProcess {
  return new CoreProcess(options);
}
