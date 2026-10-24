/** Node-only closed editor protocol. Possession authentication is not OS attestation. */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FrameDecoder, encodeFrame } from "./framing";
import {
  parseCodeAck,
  parseCodeContext,
  parseCodeGrant,
  parseCodeIntent,
  parseCodeJobView,
  parseCodeProposal,
  parseCodeReceipt,
  parseCodeReview,
  parseCodeReviewResult,
  parseTestRecipe,
  type CodeAck,
  type CodeBinding,
  type CodeContext,
  type CodeIntent,
  type CodeJobView,
  type CodeProposal,
  type CodeReceipt,
  type CodeReview,
  type CodeReviewResult,
  type TestRecipe,
} from "./coding-contracts";
export type PairTicket = Readonly<{
  version: 1;
  port: number;
  host_boot_id: string;
  secret: string;
}>;
export type LocalWorkspace = Readonly<{
  root_uri: string;
  root_file_id: string;
  window_id: string;
}>;
export type PairView = Readonly<
  LocalWorkspace & {
    host_boot_id: string;
    pair_id: string;
    root_id: string;
    challenge: string;
    status: "awaiting_confirmation" | "paired";
  }
>;
export type ContextOffer = Readonly<{
  context: CodeContext;
  captured_at_ms: number;
  expires_at_ms: number;
}>;
type Data<K extends string, P> = Readonly<{
  kind: K;
  binding: CodeBinding;
  payload: P;
}>;
export type BridgeData =
  | Data<"context.offer", ContextOffer>
  | Data<"proposal.offer", CodeProposal>
  | Data<"test.preview", TestRecipe>
  | Data<"result.dismissed", null>
  | Data<"job.status", CodeJobView>
  | Data<"review.decision", CodeReview>
  | Data<"grant.reply", CodeReviewResult>
  | Data<"journal.intent", CodeIntent>
  | Data<"journal.observed", CodeReceipt>
  | Data<"journal.ack", CodeAck>
  | Data<"reconcile.offer", CodeJobView>
  | Data<"revoke", null>;
export type Direction = "host" | "extension";
type Row = Record<string, unknown>;
export function invalid(): never {
  throw new TypeError("Invalid editor bridge");
}
export function exact(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Row;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  )
    invalid();
  return row;
}
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    invalid();
}
function base64(value: unknown, size?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.toString("base64url") !== value ||
    (size !== undefined && bytes.length !== size)
  )
    invalid();
  return bytes;
}
export function nonce(value: unknown): Buffer {
  return base64(value, 32);
}
export function parseWorkspace(value: unknown): LocalWorkspace {
  const row = exact(value, ["root_uri", "root_file_id", "window_id"]);
  identifier(row.root_file_id);
  identifier(row.window_id);
  if (typeof row.root_uri !== "string" || row.root_uri.length > 8192) invalid();
  try {
    const uri = new URL(row.root_uri);
    if (
      uri.protocol !== "file:" ||
      uri.host ||
      uri.search ||
      uri.hash ||
      pathToFileURL(fileURLToPath(uri)).href !== row.root_uri
    )
      invalid();
  } catch {
    invalid();
  }
  return value as LocalWorkspace;
}
export function parseTicket(text: string): PairTicket {
  if (text.length > 1024) invalid();
  const bytes = base64(text);
  // Reuse the strict JSON decoder, including escaped duplicate-key rejection.
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  const row = exact(
    new FrameDecoder().push(Buffer.concat([prefix, bytes]))[0],
    ["version", "port", "host_boot_id", "secret"],
  );
  if (
    row.version !== 1 ||
    typeof row.port !== "number" ||
    !Number.isInteger(row.port) ||
    row.port < 1 ||
    row.port > 65535
  )
    invalid();
  identifier(row.host_boot_id);
  nonce(row.secret);
  return row as PairTicket;
}
function parts(...values: (Buffer | string)[]): Buffer {
  return Buffer.concat(
    values.flatMap((value) => {
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
}
export function workspaceCommitment(
  secret: Buffer,
  workspace: LocalWorkspace,
  clientNonce: Buffer,
): string {
  if (clientNonce.length !== 32) invalid();
  parseWorkspace(workspace);
  return proof(
    secret,
    "sage-workspace-v1",
    Buffer.from(
      JSON.stringify([
        1,
        clientNonce.toString("base64url"),
        {
          root_file_id: workspace.root_file_id,
          root_uri: workspace.root_uri,
          window_id: workspace.window_id,
        },
      ]),
    ),
  );
}
export function initialTranscript(
  port: number,
  boot: string,
  pair: string,
  clientNonce: Buffer,
  serverNonce: Buffer,
  commitment: string,
): Buffer {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    clientNonce.length !== 32 ||
    serverNonce.length !== 32
  )
    invalid();
  identifier(boot);
  identifier(pair);
  nonce(commitment);
  return Buffer.from(
    JSON.stringify([
      1,
      port,
      boot,
      pair,
      clientNonce.toString("base64url"),
      serverNonce.toString("base64url"),
      commitment,
    ]),
  );
}
export function transcript(
  view: PairView,
  clientNonce: Buffer,
  serverNonce: Buffer,
  port: number,
  commitment: string,
): Buffer {
  const initial = JSON.parse(
    initialTranscript(
      port,
      view.host_boot_id,
      view.pair_id,
      clientNonce,
      serverNonce,
      commitment,
    ).toString("utf8"),
  ) as unknown[];
  return Buffer.from(
    JSON.stringify([
      ...initial,
      view.window_id,
      view.root_id,
      view.root_uri,
      view.root_file_id,
    ]),
  );
}
function proof(secret: Buffer, label: string, bytes: Buffer): string {
  if (secret.length !== 32) invalid();
  return createHmac("sha256", secret)
    .update(parts(label, bytes))
    .digest("base64url");
}
export function clientProof(secret: Buffer, bytes: Buffer): string {
  return proof(secret, "sage-client-v1", bytes);
}
export function hostProof(secret: Buffer, bytes: Buffer): string {
  return proof(secret, "sage-host-v1", bytes);
}
export function verifyProof(expected: string, actual: unknown): void {
  const a = nonce(expected),
    b = nonce(actual);
  if (!timingSafeEqual(a, b)) invalid();
}
export function deriveKey(
  secret: Buffer,
  clientNonce: Buffer,
  serverNonce: Buffer,
): Buffer {
  if (
    secret.length !== 32 ||
    clientNonce.length !== 32 ||
    serverNonce.length !== 32
  )
    invalid();
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.concat([clientNonce, serverNonce]),
      "sage-editor-v1",
      32,
    ),
  );
}
export function rootIdentity(workspace: LocalWorkspace): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        root_file_id: workspace.root_file_id,
        root_uri: workspace.root_uri,
      }),
    )
    .digest("hex");
}
export function challenge(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}
function sequence(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid();
}
function mac(
  key: Buffer,
  direction: Direction,
  seq: number,
  bytes: Buffer,
): string {
  if (key.length !== 32) invalid();
  sequence(seq);
  return createHmac("sha256", key)
    .update(parts(`sage-${direction}-v1`, String(seq), bytes))
    .digest("base64url");
}
export function envelope(
  key: Buffer,
  direction: Direction,
  seq: number,
  payload: Row,
): Row {
  sequence(seq);
  const bytes = encodeFrame(payload).subarray(4);
  const value = {
    version: 1,
    kind: "authenticated",
    sequence: seq,
    payload: bytes.toString("base64url"),
    mac: mac(key, direction, seq, bytes),
  };
  encodeFrame(value);
  return value;
}
export function openEnvelope(
  key: Buffer,
  direction: Direction,
  seq: number,
  value: unknown,
): Row {
  sequence(seq);
  const row = exact(value, ["version", "kind", "sequence", "payload", "mac"]);
  if (row.version !== 1 || row.kind !== "authenticated" || row.sequence !== seq)
    invalid();
  sequence(row.sequence);
  encodeFrame(row);
  const bytes = base64(row.payload);
  verifyProof(mac(key, direction, seq, bytes), row.mac);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return new FrameDecoder().push(Buffer.concat([prefix, bytes]))[0];
}
const extensionKinds = [
  "context.offer",
  "test.preview",
  "result.dismissed",
  "review.decision",
  "journal.intent",
  "journal.observed",
  "revoke",
];
const hostKinds = [
  "proposal.offer",
  "job.status",
  "grant.reply",
  "journal.ack",
  "reconcile.offer",
  "revoke",
];
export function sameBinding(left: CodeBinding, right: CodeBinding): boolean {
  return [
    "job_id",
    "boot_id",
    "pair_id",
    "window_id",
    "root_id",
    "revision",
    "policy_version",
  ].every(
    (key) => left[key as keyof CodeBinding] === right[key as keyof CodeBinding],
  );
}
export function parseContextOffer(
  value: unknown,
  now = Date.now(),
): ContextOffer {
  const row = exact(value, ["context", "captured_at_ms", "expires_at_ms"]);
  for (const key of ["captured_at_ms", "expires_at_ms"]) {
    if (
      typeof row[key] !== "number" ||
      !Number.isSafeInteger(row[key]) ||
      (row[key] as number) < 0 ||
      (row[key] as number) > 253402300799999
    )
      invalid();
  }
  const offer = row as ContextOffer;
  if (
    !Number.isSafeInteger(now) ||
    offer.captured_at_ms >= offer.expires_at_ms ||
    offer.expires_at_ms - offer.captured_at_ms > 1800000 ||
    offer.captured_at_ms > now ||
    now >= offer.expires_at_ms
  )
    invalid();
  parseCodeContext(offer.context);
  return offer;
}
export function parseBridgeData(
  value: unknown,
  direction: Direction,
  view: PairView,
  context?: CodeContext,
): BridgeData {
  encodeFrame(value);
  const row = exact(value, ["kind", "binding", "payload"]);
  if (
    typeof row.kind !== "string" ||
    !(direction === "host" ? hostKinds : extensionKinds).includes(row.kind)
  )
    invalid();
  const b = exact(row.binding, [
    "job_id",
    "boot_id",
    "pair_id",
    "window_id",
    "root_id",
    "revision",
    "policy_version",
  ]);
  for (const key of ["job_id", "boot_id", "pair_id", "window_id", "root_id"])
    identifier(b[key]);
  sequence(b.revision);
  if (
    b.policy_version !== "code-v1" ||
    b.boot_id !== view.host_boot_id ||
    b.pair_id !== view.pair_id ||
    b.window_id !== view.window_id ||
    b.root_id !== view.root_id
  )
    invalid();
  let nested: CodeBinding | undefined;
  let parsedPayload = row.payload;
  switch (row.kind) {
    case "context.offer": {
      const offer = parseContextOffer(JSON.parse(JSON.stringify(row.payload)));
      parsedPayload = offer;
      const c = offer.context;
      nested = c.binding;
      if (c.root_uri !== view.root_uri || c.root_file_id !== view.root_file_id)
        invalid();
      break;
    }
    case "proposal.offer":
      if (!context || !sameBinding(b as CodeBinding, context.binding))
        invalid();
      parseCodeProposal(row.payload, context);
      break;
    case "test.preview":
      if (parseTestRecipe(row.payload).root_id !== view.root_id) invalid();
      break;
    case "job.status":
    case "reconcile.offer":
      parsedPayload = parseCodeJobView(row.payload);
      nested = (parsedPayload as CodeJobView).binding;
      break;
    case "review.decision":
      nested = parseCodeReview(row.payload).binding;
      break;
    case "grant.reply": {
      let reply = parseCodeReviewResult(row.payload);
      if (reply.kind === "job")
        reply = { kind: "job", job: parseCodeJobView(reply.job) };
      parsedPayload = reply;
      nested =
        reply.kind === "grant"
          ? parseCodeGrant(reply.grant).binding
          : reply.kind === "job"
            ? reply.job.binding
            : reply.receipt.binding;
      break;
    }
    case "journal.intent":
      nested = parseCodeIntent(row.payload).binding;
      break;
    case "journal.observed":
      nested = parseCodeReceipt(row.payload).binding;
      break;
    case "journal.ack":
      parseCodeAck(row.payload);
      break;
    case "result.dismissed":
    case "revoke":
      if (row.payload !== null) invalid();
      break;
    default:
      invalid();
  }
  if (nested && !sameBinding(b as CodeBinding, nested)) invalid();
  return { ...row, payload: parsedPayload } as BridgeData;
}
/** One bounded framing/queue owner per socket; every failure tears down the peer. */
export class FramedPeer {
  private decoder = new FrameDecoder();
  private queue: Row[] = [];
  private reading = false;
  private writing = 0;
  private partialTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private dead = false;
  private closedHandlers = new Set<() => void>();
  handler: (message: Row) => void | Promise<void> = () => invalid();
  constructor(readonly socket: Socket) {
    socket.setNoDelay(true);
    socket.on("error", () => this.close());
    socket.on("end", () => this.close());
    socket.on("close", () => this.close());
    socket.on("data", (chunk: Buffer) => {
      try {
        const rows = this.decoder.push(
          chunk,
          8 - this.queue.length - (this.reading ? 1 : 0),
        );
        if (this.partialTimer) clearTimeout(this.partialTimer);
        this.partialTimer = this.decoder.incomplete
          ? setTimeout(() => this.close(), 10_000)
          : undefined;
        this.queue.push(...rows);
        void this.drain();
      } catch {
        this.close();
      }
    });
  }
  private async drain(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      while (!this.dead && this.queue.length) {
        const row = this.queue.shift()!;
        await this.handler(row);
      }
    } catch {
      this.close();
    } finally {
      this.reading = false;
    }
  }
  get closed(): boolean {
    return this.dead;
  }
  onClose(handler: () => void): () => void {
    this.closedHandlers.add(handler);
    return () => this.closedHandlers.delete(handler);
  }
  setDeadline(ms: number): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.close(), Math.max(0, ms));
  }
  clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = undefined;
  }
  async write(value: Row): Promise<void> {
    if (this.dead || this.writing >= 8) {
      this.close();
      invalid();
    }
    let bytes: Buffer;
    try {
      bytes = encodeFrame(value);
    } catch {
      this.close();
      invalid();
    }
    this.writing++;
    try {
      await new Promise<void>((resolve, reject) => {
        const off = this.onClose(() => {
          clearTimeout(timer);
          off();
          reject(new Error("Editor bridge closed"));
        });
        const timer = setTimeout(() => this.close(), 10_000);
        this.socket.write(bytes, (error) => {
          clearTimeout(timer);
          off();
          if (error) {
            this.close();
            reject(new Error("Editor bridge closed"));
          } else resolve();
        });
      });
    } finally {
      this.writing--;
    }
  }
  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.queue.length = 0;
    this.decoder = new FrameDecoder();
    this.clearDeadline();
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.socket.destroy();
    for (const handler of this.closedHandlers) handler();
    this.closedHandlers.clear();
  }
}
type Control =
  "control.authenticated" | "control.client-confirm" | "control.host-confirm";
export class BridgeSession {
  private incoming = 1;
  private outgoing = 1;
  private local = false;
  private remote = false;
  private context: CodeContext | undefined;
  private contextTimer: ReturnType<typeof setTimeout> | undefined;
  private lastClock = Date.now();
  private contextDeadline = 0;
  private readyResolve!: (view: PairView) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<PairView>;
  constructor(
    readonly peer: FramedPeer,
    private key: Buffer,
    readonly direction: Direction,
    private view: PairView,
    private onData: (message: BridgeData) => void | Promise<void>,
    private guard: () => void = () => {},
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.ready.catch(() => {});
    peer.onClose(() => {
      this.key.fill(0);
      this.clearContext();
      this.readyReject(new Error("Editor bridge closed"));
    });
    peer.handler = async (frame) => {
      this.check();
      const payload = openEnvelope(
        this.key,
        this.direction === "host" ? "extension" : "host",
        this.incoming++,
        frame,
      );
      const row = exact(
        payload,
        payload.kind === "data"
          ? [
              "version",
              "kind",
              "host_boot_id",
              "pair_id",
              "window_id",
              "root_id",
              "data",
            ]
          : [
              "version",
              "kind",
              "host_boot_id",
              "pair_id",
              "window_id",
              "root_id",
            ],
      );
      if (
        row.version !== 1 ||
        row.host_boot_id !== view.host_boot_id ||
        row.pair_id !== view.pair_id ||
        row.window_id !== view.window_id ||
        row.root_id !== view.root_id
      )
        invalid();
      if (row.kind === "data") {
        if (!this.paired) invalid();
        const data = parseBridgeData(
          row.data,
          direction === "host" ? "extension" : "host",
          view,
          this.context,
        );
        this.remember(data);
        await this.onData(data);
        if (this.peer.closed) return;
        this.check();
        if (data.kind === "revoke") this.peer.close();
      } else if (
        row.kind ===
        (direction === "host"
          ? "control.client-confirm"
          : "control.host-confirm")
      ) {
        if (this.remote) invalid();
        this.remote = true;
        this.finish();
      } else if (!(
        direction === "extension" && row.kind === "control.authenticated"
      ))
        invalid();
    };
  }
  get paired(): boolean {
    return this.local && this.remote && !this.peer.closed;
  }
  private payload(kind: string): Row {
    return {
      version: 1,
      kind,
      host_boot_id: this.view.host_boot_id,
      pair_id: this.view.pair_id,
      window_id: this.view.window_id,
      root_id: this.view.root_id,
    };
  }
  async control(kind: Control): Promise<void> {
    await this.peer.write(
      envelope(this.key, this.direction, this.outgoing++, this.payload(kind)),
    );
  }
  async confirm(): Promise<PairView> {
    this.guard();
    if (this.local || this.peer.closed) invalid();
    await this.control(
      this.direction === "host"
        ? "control.host-confirm"
        : "control.client-confirm",
    );
    this.local = true;
    this.finish();
    return this.ready;
  }
  private finish(): void {
    if (this.paired) {
      this.peer.clearDeadline();
      this.view = { ...this.view, status: "paired" };
      this.readyResolve(this.view);
    }
  }
  private check(): void {
    this.guard();
    const now = Date.now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.lastClock ||
      (this.contextDeadline && now >= this.contextDeadline)
    ) {
      this.peer.close();
      invalid();
    }
    this.lastClock = now;
  }
  async send(message: BridgeData): Promise<void> {
    this.check();
    if (!this.paired) invalid();
    const data = parseBridgeData(
      message,
      this.direction,
      this.view,
      this.context,
    );
    this.remember(data);
    await this.peer.write(
      envelope(this.key, this.direction, this.outgoing++, {
        ...this.payload("data"),
        data,
      }),
    );
    if (this.peer.closed) invalid();
    this.check();
    if (data.kind === "revoke") this.peer.close();
  }
  private clearContext(): void {
    this.context = undefined;
    this.contextDeadline = 0;
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = undefined;
  }
  private remember(data: BridgeData): void {
    if (data.kind === "context.offer") {
      if (this.context) {
        this.peer.close();
        invalid();
      }
      const offer = parseContextOffer(data.payload);
      this.context = offer.context;
      this.contextDeadline = offer.expires_at_ms;
      this.contextTimer = setTimeout(
        () => this.peer.close(),
        offer.expires_at_ms - Date.now(),
      );
    }
    if (
      data.kind === "result.dismissed" &&
      this.context &&
      sameBinding(data.binding, this.context.binding)
    )
      this.clearContext();
  }
  close(): void {
    this.peer.close();
  }
}
