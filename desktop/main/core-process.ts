import {
  parseCodingControlInput,
  parseHostCodingControl,
  parseHostCodingReply,
  type CodingControlInput,
  type HostCodingControl,
  type HostCodingReply,
} from "../shared/coding-contracts";
/** Fixed owned child; framed stdout only, redacted stderr, no replay after failure. */
import type { ChildProcessByStdio } from "node:child_process";
import { launchCore } from "./core-launch";
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
  failure,
  parseRequest,
  parseResponse,
  parseProgress,
  type CoreRequest,
  type CoreResponse,
  type Progress,
} from "../shared/contracts";
import { encodeFrame, FrameDecoder } from "../shared/framing";
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
type Terminal = CoreResponse | SelectionResponse | HostCodingReply;
type Pending = {
  request: CoreRequest | SelectionFrame | HostCodingControl;
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
  private lifecycle = new Set<() => void>();
  private _launches = 0;
  private bootId = "";
  private generation = 0;
  private codingGeneration = 0;
  private clearing: Promise<SelectionAck> | undefined;
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
    this.notifyLifecycle();
    this._launches++;
    this.bootId = randomUUID().replaceAll("-", "");
    this.generation = 0;
    this.codingGeneration = 0;
    const child = launchCore(this.options);
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
        this.notifyLifecycle();
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
          } else if (
            p.request.kind === "host_coding" &&
            message.kind === "host_coding_reply"
          ) {
            response = parseHostCodingReply(message, p.request);
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
      [
        "editor.pair",
        "editor.status",
        "editor.confirm",
        "editor.disconnect",
        "external.open",
        "copilot.chooseAccount",
        "copilot.disconnect",
      ].includes(request.method)
    )
      return Promise.resolve(failure(request.id, "invalid_request"));
    return this.send(request) as Promise<CoreResponse>;
  }
  async codingControl(value: CodingControlInput): Promise<HostCodingReply> {
    const input = parseCodingControlInput(value);
    if (!this.launch()) throw new TypeError("Coding control unavailable");
    const request = parseHostCodingControl({
      ...input,
      version: 1,
      kind: "host_coding",
      host_boot_id: this.bootId,
      generation: ++this.codingGeneration,
      id: randomUUID(),
    });
    const response = await this.send(request);
    if (response.kind !== "host_coding_reply")
      throw new TypeError("Coding control unavailable");
    return response;
  }
  selectAccount(account: SelectedAccount | null): Promise<SelectionAck> {
    if (account !== null) return this.changeAccount(account);
    if (this.clearing) return this.clearing;
    const clearing = this.changeAccount(null).finally(() => {
      if (this.clearing === clearing) this.clearing = undefined;
    });
    this.clearing = clearing;
    return clearing;
  }
  private async changeAccount(
    account: SelectedAccount | null,
  ): Promise<SelectionAck> {
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
    if (response.kind !== "response") {
      // A failed revocation must not leave a selected capability alive.
      // Keep the existing bounded graceful cleanup/failure fallback and report
      // unavailable rather than inventing successful cleanup evidence.
      if (account === null) await this.close();
      throw new TypeError("Selection unavailable");
    }
    return parseSelectionAck(response.result);
  }
  private send(
    request: CoreRequest | SelectionFrame | HostCodingControl,
  ): Promise<Terminal> {
    if (this.closed)
      return Promise.resolve(failure(request.id, "shutting_down"));
    if (this.seen.has(request.id))
      return Promise.resolve(failure(request.id, "duplicate_id"));
    if (this.seen.size >= 4096)
      return Promise.resolve(failure(request.id, "session_limit"));
    this.seen.add(request.id);
    const controls = [...this.pending.values()].filter(
      (entry) => entry.request.kind === "host_copilot_selection",
    ).length;
    const coding = [...this.pending.values()].filter(
      (entry) => entry.request.kind === "host_coding",
    ).length;
    const publicWork = this.pending.size - controls - coding;
    // One selection plus one reserved, coalesced revocation; public capacity
    // remains eight. A new selection cannot queue behind a pending clear.
    if (
      request.kind === "request"
        ? publicWork >= 8
        : request.kind === "host_coding"
          ? coding >= 8
          : request.account === null
            ? controls >= 2
            : controls >= 1
    )
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
        // Internal lifecycle control shares the 60s cleanup budget. This does
        // not change public 1..30000ms requests or the 30s partial-frame limit.
        request.kind === "host_coding"
          ? 30000
          : request.kind === "request"
            ? (request.timeout_ms ?? 30000)
            : SHUTDOWN_GRACE_MS,
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
  get launchGeneration(): number {
    return this._launches;
  }
  get running(): boolean {
    return !!this.child && !this.closed;
  }
  onLifecycle(handler: () => void): () => void {
    this.lifecycle.add(handler);
    return () => {
      this.lifecycle.delete(handler);
    };
  }
  private notifyLifecycle(): void {
    for (const handler of this.lifecycle) {
      try {
        handler();
      } catch {
        /* Observers cannot own child lifetime. */
      }
    }
  }
  private closing: Promise<void> | undefined;
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.notifyLifecycle();
    this.lifecycle.clear();
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
