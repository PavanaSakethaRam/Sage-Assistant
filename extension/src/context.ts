/** Explicit local snapshots. A serialized/model-supplied context is never capture authority. */
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import {
  constants,
  lstatSync,
  realpathSync,
  opendirSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FOCUS_NAMES,
  contextHash,
  parseCodeContext,
  type CodeBinding,
  type CodeContext,
  type CodeFile,
  type CodeProposal,
  parseCodeProposal,
  type CodeMode,
  type FocusName,
} from "../../desktop/shared/coding-contracts";
import {
  rootIdentity,
  type PairView,
  type ContextOffer,
} from "../../desktop/shared/editor-bridge";
import { probeRoot, validateRootSpelling } from "./root-probe";
export type ContextSelection = {
  pair: PairView;
  binding: CodeBinding;
  generation: number;
  rawRootUri: string;
  nativeIdentity: string;
  extensionPath: string;
  storagePath: string;
  mode: CodeMode;
  target?: FocusName;
  names: readonly FocusName[];
  diagnosticIds: readonly string[];
  capturedAtMs?: number;
  guard: () => void;
};
type SourceCell = { value: string | undefined };
type Snapshot = {
  sources: Set<SourceCell>;
  revocations: Set<() => void>;
  released?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  selection: ContextSelection;
  captured: number;
  expires: number;
  last: number;
  monotonic: number;
  hash: string;
  documents?: Map<FocusName, vscode.TextDocument>;
  sourceStats?: Map<FocusName, BigIntStats>;
  replaced?: {
    document: vscode.TextDocument;
    version: number;
    stat: BigIntStats;
    hash: string;
    length: number;
  };
  created?: Map<
    FocusName,
    { version: number; stat: BigIntStats; hash: string; length: number }
  >;
};
const snapshots = new WeakMap<CodeContext, Snapshot>(),
  SOURCE_CAP = 128000;
function invalid(): never {
  throw Error("Selected context unavailable or changed");
}
function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.isFile() &&
    b.isFile() &&
    a.nlink === 1n &&
    b.nlink === 1n &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function localPath(raw: string): string {
  const uri = new URL(raw);
  if (
    uri.protocol !== "file:" ||
    uri.host ||
    uri.search ||
    uri.hash ||
    uri.href !== raw
  )
    invalid();
  return fileURLToPath(uri);
}
function clearSources(snapshot: Snapshot): void {
  if (snapshot.released) return;
  snapshot.released = true;
  if (snapshot.timer) clearTimeout(snapshot.timer);
  for (const cell of snapshot.sources) cell.value = undefined;
  snapshot.sources.clear();
  const callbacks = [...snapshot.revocations];
  snapshot.revocations.clear();
  for (const callback of callbacks) callback();
}
function sourceGetter(cell: SourceCell): () => string {
  return () => {
    if (cell.value === undefined) throw Error("Expired source");
    return cell.value;
  };
}
function ownText(snapshot: Snapshot, text: string): SourceCell {
  const cell = { value: text };
  snapshot.sources.add(cell);
  return cell;
}
function sealContextText(snapshot: Snapshot, context: CodeContext): void {
  for (const file of context.files)
    Object.defineProperty(file, "text", {
      get: sourceGetter(ownText(snapshot, file.text)),
      enumerable: true,
    });
  for (let i = 0; i < (context.diagnostics?.length ?? 0); i++)
    Object.defineProperty(context.diagnostics!, i, {
      get: sourceGetter(ownText(snapshot, context.diagnostics![i])),
      enumerable: true,
    });
}
export function onContextRelease(
  context: CodeContext,
  callback: () => void,
): () => void {
  const snapshot = snapshots.get(context);
  if (!snapshot) invalid();
  check(snapshot);
  snapshot.revocations.add(callback);
  return () => snapshot.revocations.delete(callback);
}
function sourceClearer(snapshot: Snapshot, cells: SourceCell[]): () => void {
  return () => {
    for (const cell of cells) {
      cell.value = undefined;
      snapshot.sources.delete(cell);
    }
    cells.length = 0;
  };
}
/** The synchronous boundary drops the raw proposal before owned asynchronous review. */
export function ownProposal(
  context: CodeContext,
  input: CodeProposal,
): { proposal: CodeProposal; clear: () => void } {
  const snapshot = snapshots.get(context);
  if (!snapshot) invalid();
  check(snapshot);
  const valid = parseCodeProposal(input, context),
    parsed = { ...valid, files: valid.files.map((file) => ({ ...file })) },
    cells: SourceCell[] = [];
  for (const file of parsed.files) {
    const cell = ownText(snapshot, file.text);
    cells.push(cell);
    Object.defineProperty(file, "text", {
      get: sourceGetter(cell),
      enumerable: true,
    });
    Object.freeze(file);
  }
  const explanation = ownText(snapshot, parsed.explanation);
  cells.push(explanation);
  Object.defineProperty(parsed, "explanation", {
    get: sourceGetter(explanation),
    enumerable: true,
  });
  Object.freeze(parsed.files);
  Object.freeze(parsed);
  return { proposal: parsed, clear: sourceClearer(snapshot, cells) };
}
function check(snapshot: Snapshot): string {
  try {
    if (snapshot.released) invalid();
    const s = snapshot.selection;
    s.guard();
    const now = Date.now();
    if (
      !Number.isSafeInteger(now) ||
      now < snapshot.last ||
      now < snapshot.captured ||
      now >= snapshot.expires ||
      performance.now() - snapshot.monotonic >=
        snapshot.expires - snapshot.captured
    )
      invalid();
    snapshot.last = now;
    if (
      s.pair.status !== "paired" ||
      rootIdentity(s.pair) !== s.pair.root_id ||
      s.binding.boot_id !== s.pair.host_boot_id ||
      s.binding.pair_id !== s.pair.pair_id ||
      s.binding.window_id !== s.pair.window_id ||
      s.binding.root_id !== s.pair.root_id ||
      !Number.isSafeInteger(s.generation) ||
      s.generation < 0
    )
      invalid();
    const root = localPath(s.rawRootUri);
    validateRootSpelling(root);
    if (
      pathToFileURL(root).href !== s.pair.root_uri ||
      realpathSync(root) !== root
    )
      invalid();
    const info = lstatSync(root, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      `${info.dev}-${info.ino}` !== s.pair.root_file_id
    )
      invalid();
    return root;
  } catch (error) {
    clearSources(snapshot);
    throw error;
  }
}

async function native(snapshot: Snapshot): Promise<string> {
  const root = check(snapshot),
    s = snapshot.selection;
  if (
    (await probeRoot(root, s.extensionPath, s.storagePath, () => {
      check(snapshot);
    })) !== s.nativeIdentity
  )
    invalid();
  check(snapshot);
  return root;
}
function names(s: ContextSelection): void {
  if (
    !Array.isArray(s.names) ||
    s.names.some((n) => !FOCUS_NAMES.includes(n)) ||
    new Set(s.names).size !== s.names.length ||
    s.names.length > 4 ||
    !Array.isArray(s.diagnosticIds) ||
    s.diagnosticIds.length > 64000 ||
    new Set(s.diagnosticIds).size !== s.diagnosticIds.length
  )
    invalid();
  if (s.mode === "create_focus_project") {
    if (s.names.length || s.target !== undefined || s.diagnosticIds.length)
      invalid();
  } else if (
    s.mode !== "replace_focus_file" ||
    !s.target ||
    !s.names.includes(s.target) ||
    s.names.length < 1
  )
    invalid();
}
export function diagnosticChoices(
  selected: readonly FocusName[],
  root: string,
): { id: string; text: string }[] {
  const result: { id: string; text: string }[] = [];
  let codepoints = 0;
  for (const name of selected) {
    if (!FOCUS_NAMES.includes(name)) invalid();
    const diagnostics = vscode.languages.getDiagnostics(
      vscode.Uri.file(join(root, name)),
    );
    if (diagnostics.length > 64000) invalid();
    for (const [i, d] of diagnostics.entries()) {
      const text = `${name}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}`;
      for (const _point of text) {
        void _point;
        if (++codepoints > 64000) invalid();
      }
      result.push({ id: `${name}:${i}`, text });
    }
  }
  if (result.length > 64000) invalid();
  return result;
}
function diagnostics(snapshot: Snapshot): string[] {
  if (!snapshot.selection.diagnosticIds.length) return [];
  const choices = diagnosticChoices(snapshot.selection.names, check(snapshot));
  return snapshot.selection.diagnosticIds.map((id) => {
    const choice = choices.find((c) => c.id === id);
    if (!choice) invalid();
    return choice.text;
  });
}
async function readFile(
  snapshot: Snapshot,
  name: FocusName,
  finalChecks: (() => void)[],
): Promise<CodeFile> {
  const root = check(snapshot),
    path = join(root, name),
    before = await lstat(path, { bigint: true });
  check(snapshot);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(SOURCE_CAP)
  )
    invalid();
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    check(snapshot);
    const opened = await handle.stat({ bigint: true });
    check(snapshot);
    if (!sameStat(before, opened)) invalid();
    const buffer = Buffer.alloc(SOURCE_CAP + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      check(snapshot);
      offset += read.bytesRead;
      if (!read.bytesRead) break;
    }
    if (offset > SOURCE_CAP) invalid();
    bytes = buffer.subarray(0, offset);
    const after = await handle.stat({ bigint: true });
    check(snapshot);
    if (!sameStat(before, after) || BigInt(offset) !== before.size) invalid();
  } finally {
    await handle.close();
  }
  check(snapshot);
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (
    text.startsWith("\ufeff") ||
    text.includes("\r") ||
    [...text].length > 32000
  )
    invalid();
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path),
  );
  check(snapshot);
  const known = snapshot.documents?.get(name);
  if (document.isClosed || (known && known !== document)) invalid();
  if (snapshot.selection.mode === "replace_focus_file") {
    snapshot.documents ??= new Map();
    snapshot.documents.set(name, document);
    const source = snapshot.sourceStats?.get(name);
    if (source && !sameStat(source, before)) invalid();
    snapshot.sourceStats ??= new Map();
    snapshot.sourceStats.set(name, before);
  }
  const version = document.version;
  if (
    localPath(document.uri.toString()) !== path ||
    document.isDirty ||
    document.eol !== vscode.EndOfLine.LF ||
    document.getText() !== text
  )
    invalid();
  const after = await lstat(path, { bigint: true });
  check(snapshot);
  if (
    !sameStat(before, after) ||
    document.isDirty ||
    document.version !== version ||
    document.getText() !== text
  )
    invalid();
  finalChecks.push(() => {
    check(snapshot);
    if (
      !sameStat(before, lstatSync(path, { bigint: true })) ||
      document.isDirty ||
      document.version !== version ||
      document.eol !== vscode.EndOfLine.LF ||
      document.getText() !== text
    )
      invalid();
  });
  return {
    name,
    text,
    text_hash: digest(text),
    disk_hash: digest(bytes),
    document_version: version,
    file_id: `${before.dev}-${before.ino}`,
  };
}
async function capture(
  snapshot: Snapshot,
): Promise<{ files: CodeFile[]; diagnostics: string[] }> {
  const root = await native(snapshot);
  check(snapshot);
  const s = snapshot.selection;
  if (s.mode === "create_focus_project") {
    const directory = opendirSync(root);
    try {
      if (directory.readSync()) invalid();
    } finally {
      directory.closeSync();
    }
    check(snapshot);
    return { files: [], diagnostics: [] };
  }
  const files: CodeFile[] = [],
    finalChecks: (() => void)[] = [];
  for (const name of s.names) {
    files.push(await readFile(snapshot, name, finalChecks));
    check(snapshot);
  }
  const selected = diagnostics(snapshot);
  await native(snapshot);
  check(snapshot);
  for (const finalCheck of finalChecks) finalCheck();
  return { files, diagnostics: selected };
}
export async function captureContext(
  selection: ContextSelection,
): Promise<CodeContext> {
  const captured = selection.capturedAtMs ?? Date.now();
  if (
    !Number.isSafeInteger(captured) ||
    captured < 0 ||
    captured > 253402300799999 - 1800000
  )
    invalid();
  const s = {
    ...selection,
    pair: { ...selection.pair },
    binding: { ...selection.binding },
    names: [...selection.names],
    diagnosticIds: [...selection.diagnosticIds],
  };
  names(s);
  const snapshot: Snapshot = {
    sources: new Set(),
    revocations: new Set(),
    selection: s,
    captured,
    expires: captured + 1800000,
    last: captured,
    monotonic: performance.now() - (Date.now() - captured),
    hash: "",
  };
  const values = await capture(snapshot);
  check(snapshot);
  const value: CodeContext = {
    binding: s.binding,
    mode: s.mode,
    root_uri: s.pair.root_uri,
    root_file_id: s.pair.root_file_id,
    ...values,
    context_hash: "0".repeat(64),
    ...(s.target ? { target: s.target } : {}),
  };
  parseCodeContext(value);
  const hash = await contextHash(value);
  check(snapshot);
  const context = { ...value, context_hash: hash };
  snapshot.hash = hash;
  sealContextText(snapshot, context);
  snapshots.set(context, snapshot);
  snapshot.timer = setTimeout(
    () => releaseContext(context),
    Math.max(0, snapshot.expires - Date.now()),
  );
  snapshot.timer.unref?.();
  try {
    await validateContext(context);
    check(snapshot);
  } catch (error) {
    releaseContext(context);
    throw error;
  }
  // No mutable caller-owned state or document buffers survive as snapshot metadata.
  Object.freeze(context.binding);
  context.files.forEach(Object.freeze);
  Object.freeze(context.files);
  Object.freeze(context.diagnostics);
  return Object.freeze(context);
}
export async function validateContext(context: CodeContext): Promise<void> {
  const snapshot = snapshots.get(context);
  if (!snapshot) invalid();
  try {
    check(snapshot);
    if (
      context.context_hash !== snapshot.hash ||
      (await contextHash(context)) !== snapshot.hash
    )
      invalid();
    check(snapshot);
    const current = await capture(snapshot);
    check(snapshot);
    if (
      JSON.stringify(current.files) !== JSON.stringify(context.files) ||
      JSON.stringify(current.diagnostics) !==
        JSON.stringify(context.diagnostics ?? [])
    )
      invalid();
  } catch (error) {
    releaseContext(context);
    throw error;
  }
}
export function contextOffer(context: CodeContext): ContextOffer {
  const snapshot = snapshots.get(context);
  if (!snapshot) invalid();
  check(snapshot);
  return {
    context,
    captured_at_ms: snapshot.captured,
    expires_at_ms: snapshot.expires,
  };
}
export function releaseContext(context: CodeContext): void {
  const snapshot = snapshots.get(context);
  snapshots.delete(context);
  if (snapshot) clearSources(snapshot);
}

/** Visible local disclosure metadata, partitioned exactly like the provider's context budget. */
export function disclosureSummary(context: CodeContext): readonly string[] {
  contextOffer(context);
  const points = (value: string) => [...value].length;
  const selected = context.files.map((file) => file.name);
  const readOnly = selected.filter((name) => name !== context.target);
  const source = context.files.reduce(
    (sum, file) => sum + points(file.text),
    0,
  );
  const diagnostics = (context.diagnostics ?? []).reduce(
    (sum, text) => sum + points(text),
    0,
  );
  const metadata =
    points(context.mode) +
    points(context.target ?? "") +
    selected.reduce((sum, name) => sum + points(name), 0);
  const lines = [
    `Mode: ${context.mode}`,
    `Selected manifest (${selected.length} existing): ${selected.join(", ") || "none"}`,
    `Target: ${context.target ?? "new empty project"}`,
    `Read-only scope: ${readOnly.join(", ") || "none"}`,
  ];
  if (context.mode === "create_focus_project")
    lines.push(`Creation outputs: ${FOCUS_NAMES.join(", ")}`);
  const hash = (label: string, value: string) => {
    lines.push(
      `${label} SHA256 (1/2): ${value.slice(0, 32)}`,
      `${label} SHA256 (2/2): ${value.slice(32)}`,
    );
  };
  hash("Context", context.context_hash);
  for (const file of context.files) {
    lines.push(`${file.name} source: ${points(file.text)} code points`);
    hash(`${file.name} text`, file.text_hash);
    hash(`${file.name} disk`, file.disk_hash);
  }
  lines.push(
    `Source: ${source} code points`,
    `Selected diagnostics: ${diagnostics} code points (${(context.diagnostics ?? []).length} selected)`,
    `Provider-visible metadata: ${metadata} code points`,
    `Total: ${source + diagnostics + metadata} / 64000 code points`,
  );
  return Object.freeze(lines);
}

/** Original capture authority is retained while only its approved created prefix grows. */
export type CreatedPrefix = Readonly<{ name: FocusName; stat: BigIntStats }>;
export async function validateCreateProgress(
  context: CodeContext,
  proposal: import("../../desktop/shared/coding-contracts").CodeProposal,
  prefix: readonly CreatedPrefix[],
): Promise<string> {
  const snapshot = snapshots.get(context);
  if (!snapshot) invalid();
  try {
    check(snapshot);
    if (
      context.mode !== "create_focus_project" ||
      context.context_hash !== snapshot.hash ||
      prefix.length > 4 ||
      prefix.length < (snapshot.created?.size ?? 0) ||
      prefix.length > (snapshot.created?.size ?? 0) + 1
    )
      invalid();
    const root = await native(snapshot);
    check(snapshot);
    const finalChecks: (() => void)[] = [];
    const versions: NonNullable<Snapshot["created"]> = new Map();
    const directoryCheck = () => {
      check(snapshot);
      const directory = opendirSync(root),
        found: string[] = [];
      try {
        for (
          let entry = directory.readSync();
          entry;
          entry = directory.readSync()
        ) {
          if (found.length === 4) invalid();
          found.push(entry.name);
        }
      } finally {
        directory.closeSync();
      }
      if (
        found.length !== prefix.length ||
        found.some((n) => !prefix.some((p) => p.name === n))
      )
        invalid();
    };
    directoryCheck();
    const uncreatedBufferCheck = () => {
      for (const name of FOCUS_NAMES.filter(
        (name) => !prefix.some((item) => item.name === name),
      )) {
        const uri = vscode.Uri.file(join(root, name)).toString();
        if (
          vscode.workspace.textDocuments?.some(
            (document) => document.uri.toString() === uri,
          )
        )
          invalid();
      }
    };
    uncreatedBufferCheck();
    for (const [i, item] of prefix.entries()) {
      if (item.name !== FOCUS_NAMES[i]) invalid();
      const file = await readFile(snapshot, item.name, finalChecks);
      check(snapshot);
      const approved = proposal.files.find((f) => f.name === item.name);
      const previous = snapshot.created?.get(item.name);
      if (
        previous !== undefined &&
        (previous.version !== file.document_version ||
          !sameStat(previous.stat, item.stat) ||
          previous.hash !== file.disk_hash)
      )
        invalid();
      versions.set(item.name, {
        version: file.document_version,
        stat: item.stat,
        hash: file.disk_hash,
        length: Buffer.byteLength(file.text),
      });
      if (
        !approved ||
        file.text !== approved.text ||
        file.file_id !== `${item.stat.dev}-${item.stat.ino}` ||
        !sameStat(item.stat, lstatSync(join(root, item.name), { bigint: true }))
      )
        invalid();
      const known =
        vscode.workspace.textDocuments?.filter(
          (d) =>
            d.uri.toString() ===
            vscode.Uri.file(join(root, item.name)).toString(),
        ) ?? [];
      for (const document of known) {
        const version = document.version;
        finalChecks.push(() => {
          if (
            document.isDirty ||
            document.version !== version ||
            document.getText() !== approved.text
          )
            invalid();
        });
      }
    }
    await native(snapshot);
    check(snapshot);
    directoryCheck();
    uncreatedBufferCheck();
    for (const finalCheck of finalChecks) finalCheck();
    snapshot.created = versions;
    return root;
  } catch (error) {
    releaseContext(context);
    throw error;
  }
}

/** A bounded original-target observation remains possible after authority has expired. */
export function replacementState(context: CodeContext) {
  const snapshot = snapshots.get(context);
  if (!snapshot || context.mode !== "replace_focus_file" || !context.target)
    invalid();
  check(snapshot);
  const root = check(snapshot),
    path = join(root, context.target),
    rootFileId = context.root_file_id,
    target = context.target,
    sources = context.files.map((file) => ({
      name: file.name,
      hash: file.text_hash,
      diskHash: file.disk_hash,
      length: Buffer.byteLength(file.text),
      version: file.document_version,
      fileId: file.file_id,
      stat: snapshot.sourceStats!.get(file.name)!,
      document: snapshot.documents!.get(file.name)!,
    })),
    original = sources.find((file) => file.name === target)!,
    document = original.document;
  if (!document) invalid();
  const disk = (name: FocusName = target) => {
    const path = join(root, name);
    const rootStat = lstatSync(root, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      realpathSync(root) !== root ||
      `${rootStat.dev}-${rootStat.ino}` !== rootFileId
    )
      invalid();
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(SOURCE_CAP) ||
      realpathSync(path) !== path
    )
      invalid();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameStat(before, fstatSync(fd, { bigint: true }))) invalid();
      const buffer = Buffer.alloc(SOURCE_CAP + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
        offset += n;
        if (!n) break;
      }
      const stat = fstatSync(fd, { bigint: true });
      if (
        offset > SOURCE_CAP ||
        BigInt(offset) !== stat.size ||
        !sameStat(before, stat) ||
        !sameStat(stat, lstatSync(path, { bigint: true }))
      )
        invalid();
      return { stat, hash: digest(buffer.subarray(0, offset)), length: offset };
    } finally {
      closeSync(fd);
    }
  };
  const live = (
    hash: string,
    length: number,
    version: number,
    dirty: boolean,
  ) => {
    if (
      document.isClosed ||
      !vscode.workspace.textDocuments.includes(document) ||
      localPath(document.uri.toString()) !== path ||
      document.version !== version ||
      digest(document.getText()) !== hash ||
      Buffer.byteLength(document.getText()) !== length ||
      document.isDirty !== dirty ||
      document.eol !== vscode.EndOfLine.LF ||
      document.encoding !== "utf8"
    )
      invalid();
    if (
      vscode.workspace
        .getConfiguration("files", {
          uri: document.uri,
          languageId: document.languageId,
        })
        .get("autoSave") !== "off"
    )
      invalid();
  };
  const owned = () => {
    if (snapshots.get(context) !== snapshot) invalid();
    check(snapshot);
  };
  const unchanged = (file: typeof original, dirty = false) => {
    const d = file.document,
      current = disk(file.name);
    return (
      !d.isClosed &&
      vscode.workspace.textDocuments.includes(d) &&
      d.isDirty === dirty &&
      d.version === file.version &&
      digest(d.getText()) === file.hash &&
      Buffer.byteLength(d.getText()) === file.length &&
      d.eol === vscode.EndOfLine.LF &&
      d.encoding === "utf8" &&
      current.hash === file.diskHash &&
      sameStat(current.stat, file.stat)
    );
  };
  const originalCheck = () => {
    owned();
    for (const file of sources) if (!unchanged(file)) invalid();
    live(original.hash, original.length, original.version, false);
  };
  const unchangedSources = () =>
    sources
      .filter((file) => file.name !== target)
      .every((file) => unchanged(file));
  const sourceStat = disk().stat;
  return {
    document,
    originalHash: original.diskHash,
    originalLength: original.length,
    originalCheck,
    beforeSave(hash: string, length: number, version: number) {
      owned();
      live(hash, length, version, true);
      if (!unchangedSources()) invalid();
      const observed = disk();
      if (
        observed.hash !== original.diskHash ||
        !sameStat(observed.stat, sourceStat)
      )
        invalid();
    },
    observe: () => disk(),
    originalDisk: (observed: ReturnType<typeof disk>) =>
      sameStat(sourceStat, observed.stat),
    unchangedSources,
    retain(
      observed: ReturnType<typeof disk>,
      version: number,
      hash: string,
      length: number,
    ) {
      owned();
      live(hash, length, version, false);
      if (!sameStat(observed.stat, disk().stat) || !unchangedSources())
        invalid();
      snapshot.replaced = { document, version: document.version, ...observed };
    },
  };
}
