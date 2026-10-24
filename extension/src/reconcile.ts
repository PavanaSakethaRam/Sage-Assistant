/** Bounded informational observation; no source lease or effect authority. */
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FOCUS_NAMES,
  type CodeJobView,
  type FocusName,
  type CodeReceipt,
} from "../../desktop/shared/coding-contracts";
import {
  historicalJob,
  parseHistoricalJob,
  rootIdentity,
  sameBinding,
  type PairView,
} from "../../desktop/shared/editor-bridge";
import {
  EffectJournal,
  journalHash,
  receiptProjection,
  type JobEvidence,
  type JournalIntent,
  type PendingEvidence,
} from "./journal";
import { probeRoot, validateRootSpelling } from "./root-probe";
export type InspectionOwner = {
  pair: PairView;
  rawRootUri: string;
  nativeIdentity: string;
  extensionPath: string;
  storagePath: string;
  guard: () => void;
  journal: EffectJournal;
};
type HashObservation =
  | {
      status: "observed";
      hash: string;
      length: number;
      matches: string[];
      version?: number;
      dirty?: boolean;
    }
  | { status: "missing" | "unavailable" | "not_open" };
export type Inspection = {
  job: CodeJobView;
  root: "verified" | "unverified";
  local: JobEvidence;
  targets: {
    name: FocusName;
    disk: HashObservation;
    buffer: HashObservation;
  }[];
};
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    !a.isSymbolicLink() &&
    !b.isSymbolicLink() &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function rootCheck(owner: InspectionOwner, job: CodeJobView): string {
  owner.guard();
  if (
    owner.pair.status !== "paired" ||
    !historicalJob(job, owner.pair) ||
    rootIdentity(owner.pair) !== owner.pair.root_id
  )
    throw Error("Historical root unverified");
  const uri = new URL(owner.rawRootUri),
    root = fileURLToPath(uri);
  if (
    uri.protocol !== "file:" ||
    uri.host ||
    uri.hash ||
    uri.search ||
    uri.href !== owner.rawRootUri ||
    pathToFileURL(root).href !== owner.pair.root_uri
  )
    throw Error("Historical root unverified");
  validateRootSpelling(root);
  const info = lstatSync(root, { bigint: true });
  if (
    realpathSync(root) !== root ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    `${info.dev}-${info.ino}` !== owner.pair.root_file_id
  )
    throw Error("Historical root unverified");
  return root;
}
function matches(
  job: CodeJobView,
  local: JobEvidence,
  name: FocusName,
  digest: string,
): string[] {
  const result = new Set<string>();
  for (const record of job.hashes.filter((item) => item.name === name)) {
    if (record.source_hash === digest) result.add("original");
    if (record.proposed_hash === digest) result.add("proposed");
    if (record.observed_hash === digest) result.add("recorded observation");
  }
  for (const record of local.operations.flatMap(
    (operation) => operation.intents,
  ))
    if (
      "target" in record &&
      record.target === name &&
      record.expected_hash === digest
    )
      result.add("proposed");
  for (const record of [
    ...job.receipts,
    ...local.operations.flatMap((operation) => operation.observations),
  ])
    if (record.scope !== "code.test" && record.target === name) {
      if (record.expected_hash === digest) result.add("proposed");
      if (record.observed_hash === digest) result.add("recorded observation");
    }
  return [...result];
}
async function diskHash(
  path: string,
  check: () => void,
): Promise<{ hash: string; length: number }> {
  check();
  const before = await lstat(path, { bigint: true });
  check();
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 128000n
  )
    throw Error("Unsafe target");
  const reader = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    check();
    const opened = await reader.stat({ bigint: true });
    check();
    if (!sameFile(before, opened)) throw Error("Changed target");
    // The raw read buffer is scoped to this hashing continuation, before later identity awaits.
    const observed = await (async () => {
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await reader.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        check();
        length += read.bytesRead;
        if (!read.bytesRead) break;
      }
      if (length !== Number(before.size)) throw Error("Changed target");
      return { hash: hash(bytes.subarray(0, length)), length };
    })();
    check();
    const after = await reader.stat({ bigint: true });
    check();
    const current = await lstat(path, { bigint: true });
    check();
    if (!sameFile(before, after) || !sameFile(after, current))
      throw Error("Changed target");
    return observed;
  } finally {
    await reader.close();
    check();
  }
}
function bufferHash(path: string, check: () => void): HashObservation {
  check();
  const uri = vscode.Uri.file(path).toString();
  const document = vscode.workspace.textDocuments.find(
    (item) => item.uri.toString() === uri,
  );
  if (!document) return { status: "not_open" };
  const version = document.version,
    dirty = document.isDirty;
  if (document.isClosed || document.eol !== vscode.EndOfLine.LF)
    return { status: "unavailable" };
  const utf16Bound = document.offsetAt(document.positionAt(64001));
  check();
  if (
    !Number.isSafeInteger(utf16Bound) ||
    utf16Bound < 0 ||
    utf16Bound > 64000 ||
    document.isClosed ||
    document.version !== version ||
    document.isDirty !== dirty
  )
    return { status: "unavailable" };
  const observed = (() => {
    const text = document.getText();
    if (
      text.startsWith("\ufeff") ||
      text.includes("\r") ||
      /[\uD800-\uDFFF]/u.test(text) ||
      [...text].length > 32000 ||
      Buffer.byteLength(text) > 128000
    )
      return undefined;
    return { hash: hash(text), length: Buffer.byteLength(text) };
  })();
  check();
  if (
    !observed ||
    document.isClosed ||
    document.version !== version ||
    document.isDirty !== dirty ||
    !vscode.workspace.textDocuments.includes(document)
  )
    return { status: "unavailable" };
  return { status: "observed", ...observed, version, dirty, matches: [] };
}
export async function inspectInterruptedJob(
  value: CodeJobView,
  owner: InspectionOwner,
): Promise<Inspection> {
  const job = parseHistoricalJob(value);
  const started = Date.now(),
    mono = performance.now();
  let last = started;
  const check = () => {
    const now = Date.now();
    if (
      now < last ||
      now - started >= 30000 ||
      performance.now() - mono >= 30000
    )
      throw Error("Inspection expired");
    last = now;
    rootCheck(owner, job);
  };
  const result: Inspection = {
    job,
    root: "unverified",
    local: { complete: false, operations: [] },
    targets: [],
  };
  try {
    check();
    const root = rootCheck(owner, job);
    if (
      (await probeRoot(root, owner.extensionPath, owner.storagePath, check)) !==
      owner.nativeIdentity
    )
      return result;
    check();
    result.local = await owner.journal.inspectJob(job.binding);
    check();
    const evidenced = new Set<FocusName>(
      job.hashes.map((record) => record.name),
    );
    for (const item of [
      ...job.receipts,
      ...result.local.operations.flatMap((operation) => [
        ...operation.intents,
        ...operation.observations,
      ]),
    ])
      if ("target" in item) evidenced.add(item.target);
    for (const name of FOCUS_NAMES.filter((name) => evidenced.has(name))) {
      check();
      let disk: HashObservation;
      try {
        const observed = await diskHash(join(root, name), check);
        check();
        disk = {
          status: "observed",
          ...observed,
          matches: matches(job, result.local, name, observed.hash),
        };
      } catch (error) {
        check();
        disk = {
          status:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing"
              : "unavailable",
        };
      }
      const buffer = bufferHash(join(root, name), check);
      if (buffer.status === "observed")
        buffer.matches = matches(job, result.local, name, buffer.hash);
      result.targets.push({ name, disk, buffer });
    }
    check();
    if (
      (await probeRoot(root, owner.extensionPath, owner.storagePath, check)) !==
      owner.nativeIdentity
    )
      throw Error("Historical root unverified");
    check();
    result.root = "verified";
    return result;
  } catch {
    result.targets = [];
    result.root = "unverified";
    return result;
  }
}
function receiptIdentity(
  a: CodeReceipt | JournalIntent,
  b: CodeReceipt,
): boolean {
  return (
    sameBinding(a.binding, b.binding) &&
    a.operation_id === b.operation_id &&
    a.effect_id === b.effect_id &&
    a.scope === b.scope &&
    a.ordinal === b.ordinal &&
    a.expected_hash === b.expected_hash &&
    (a.scope === "code.test" ||
      (b.scope !== "code.test" && "target" in a && a.target === b.target))
  );
}
export function inspectionText(result: Inspection): string {
  const { job, local } = result;
  const lines = [
    "Sage interrupted-job inspection — informational only",
    `Job: ${job.binding.job_id}; state: ${job.state}`,
    `Historical root ${result.root}.`,
    `Local evidence: ${local.complete ? "bounded inventory complete" : "incomplete/unavailable; absence is not established"}.`,
    "No effect was retried or acknowledged. New work requires fresh context and approvals.",
  ];
  for (const operation of local.operations) {
    for (const intent of operation.intents) {
      const observed = operation.observations.find(
        (receipt) => receipt.effect_id === intent.effect_id,
      );
      const core = job.receipts.find(
        (receipt) =>
          receipt.effect_id === intent.effect_id &&
          receipt.operation_id === intent.operation_id,
      );
      const intentConflict = core && !receiptIdentity(intent, core);
      const agrees =
        observed &&
        core &&
        receiptIdentity(observed, core) &&
        journalHash(receiptProjection(observed)) ===
          journalHash(receiptProjection(core));
      lines.push(
        `Operation ${operation.operation_id}, effect ${intent.effect_id}, ${intent.scope}: local intent recorded; local observation ${observed ? observed.status : "missing"}; Core observation ${core ? core.status : "missing"}${intentConflict ? "; conflicting intent/receipt identity" : ""}${observed && core ? (agrees ? "; matching observations" : "; conflicting observations") : ""}. Local ACK is not proof of Core ACK receipt.`,
      );
    }
  }
  for (const receipt of job.receipts)
    lines.push(
      `Core past receipt: ${receipt.scope}, ${receipt.operation_id}/${receipt.effect_id}, ${receipt.status}.`,
    );
  if (!result.targets.length)
    lines.push(
      result.root === "verified"
        ? "No retained target hash evidence."
        : "Historical root unverified; no current project observations.",
    );
  for (const target of result.targets) {
    for (const [kind, observed] of [
      ["Raw disk", target.disk],
      [
        "Logical visible-text UTF-8 buffer (actual editor encoding/BOM unverified)",
        target.buffer,
      ],
    ] as const)
      lines.push(
        `${target.name} — ${kind}: ${observed.status}${observed.status === "observed" ? `; SHA256 ${observed.hash}; ${observed.length} bytes; matches ${observed.matches.join(", ") || "other"}${observed.version === undefined ? "" : `; version ${observed.version}; dirty ${observed.dirty}`}` : ""}.`,
      );
    const proposed = [target.disk, target.buffer].some(
      (observed) =>
        observed.status === "observed" && observed.matches.includes("proposed"),
    );
    if (
      proposed &&
      !job.receipts.some(
        (receipt) =>
          receipt.scope !== "code.test" &&
          receipt.target === target.name &&
          ["created", "applied_saved"].includes(receipt.status) &&
          receipt.observed_hash === receipt.expected_hash &&
          typeof receipt.observed_length === "number" &&
          [target.disk, target.buffer].some(
            (observed) =>
              observed.status === "observed" &&
              observed.matches.includes("proposed") &&
              observed.hash === receipt.expected_hash &&
              observed.length === receipt.observed_length,
          ),
      )
    )
      lines.push("Observed proposed content; completion receipt missing.");
  }
  const tests = job.receipts.filter((receipt) => receipt.scope === "code.test");
  lines.push(
    tests.length
      ? "Test receipts above record past facts only; any missing/incomplete test receipt has unknown outcome."
      : "Test outcome: unknown; no complete matching test receipt.",
  );
  if (
    tests.some(
      (receipt) =>
        !["passed", "failed"].includes(receipt.status) ||
        !receipt.output_digest ||
        (typeof receipt.exit_code !== "number" &&
          typeof receipt.signal !== "string") ||
        receipt.cancel_requested ||
        receipt.timeout ||
        receipt.overflow,
    )
  )
    lines.push(
      "Test outcome: unknown; retained test receipt is incomplete or uncertain.",
    );
  lines.push(
    "An earlier test process or descendant may remain; this inspection does not inspect or terminate saved processes.",
    "Current hashes do not prove who changed a file, when, or whether an earlier effect completed.",
  );
  return lines.join("\n");
}
export function pendingText(entry: PendingEvidence): string {
  const lines = [
    "Sage interrupted private journal inspection",
    `Entry: ${entry.name}; classification: ${entry.classification}`,
    `Digest: ${entry.digest ?? "unavailable"}; original modification time: ${entry.mtime === null ? "unavailable" : new Date(entry.mtime).toISOString()}.`,
    "Files may already have changed. Missing observations mean intent/effect/receipt and test outcomes are unknown.",
  ];
  if (entry.operation) {
    lines.push(
      `Operation: ${entry.operation.operation_id}; historical root: ${entry.operation.intents[0].binding.root_id}; created: ${entry.operation.created_at}; updated: ${entry.operation.updated_at}; expiry: ${entry.operation.expires_at}.`,
    );
    for (const intent of entry.operation.intents)
      lines.push(
        `Effect ${intent.effect_id}; ${intent.scope}; ${"target" in intent ? intent.target : "fixed test"}; expected ${intent.expected_hash}; local observation ${entry.operation.observations.find((record) => record.effect_id === intent.effect_id)?.status ?? "missing"}. Local ACK is not a Core ACK.`,
      );
    lines.push(
      "Validated version1 source-free metadata. This does not verify the current project root or completion.",
    );
  } else
    lines.push(
      "These bounded private bytes are not validated source-free metadata.",
    );
  lines.push(
    ["supported_v1", "malformed_v1"].includes(entry.classification)
      ? "Acknowledgment retains this unchanged evidence privately with its original retention age. It does not recover, retry, authorize, or mark success. New work needs fresh pairing, context and approvals."
      : "Blocked: use a compatible extension version or support and preserve a manual private-state backup. This build cannot safely acknowledge these bytes.",
  );
  return lines.join("\n");
}
/** One fixed slot independent of current context/diff/test providers and their leases. */
export class InspectionView {
  private readonly uri = vscode.Uri.parse(
    "sage-inspection:/interrupted-job.txt",
  );
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly provider: vscode.Disposable;
  private readonly tabs: vscode.Disposable;
  private text = "Inspection dismissed or expired.";
  private epoch = 0;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor() {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(
      "sage-inspection",
      {
        onDidChange: this.changed.event,
        provideTextDocumentContent: (uri) =>
          uri.toString() === this.uri.toString()
            ? this.text
            : "Inspection unavailable.",
      },
    );
    this.tabs = vscode.window.tabGroups.onDidChangeTabs((event) => {
      if (
        this.active &&
        event.closed.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.toString() === this.uri.toString(),
        )
      )
        void this.clear();
    });
  }
  clear(): Promise<void> {
    this.epoch++;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.text = "Inspection dismissed or expired.";
    this.changed.fire(this.uri);
    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputText &&
          tab.input.uri.toString() === this.uri.toString(),
      );
    return tabs.length
      ? Promise.resolve(vscode.window.tabGroups.close(tabs, true)).then(
          () => {},
        )
      : Promise.resolve();
  }
  async show(
    result: Inspection | PendingEvidence,
    guard: () => void,
  ): Promise<void> {
    const cleanup = this.clear();
    const epoch = this.epoch,
      started = Date.now(),
      mono = performance.now();
    const check = () => {
      guard();
      if (
        epoch !== this.epoch ||
        Date.now() < started ||
        Date.now() - started >= 1800000 ||
        performance.now() - mono >= 1800000
      )
        throw Error("Inspection expired");
    };
    try {
      await cleanup;
      check();
      this.active = true;
      this.text =
        "classification" in result
          ? pendingText(result)
          : inspectionText(result);
      this.changed.fire(this.uri);
      this.timer = setTimeout(() => {
        void this.clear();
      }, 1800000);
      const document = await vscode.workspace.openTextDocument(this.uri);
      check();
      await vscode.window.showTextDocument(document, { preview: true });
      check();
    } catch (error) {
      if (epoch === this.epoch || !this.active) await this.clear();
      throw error;
    }
  }
  dispose(): void {
    void this.clear();
    this.tabs.dispose();
    this.provider.dispose();
    this.changed.dispose();
  }
}
