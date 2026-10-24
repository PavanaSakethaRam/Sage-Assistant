/** Explicit local snapshots. A serialized/model-supplied context is never capture authority. */
import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, opendirSync } from "node:fs";
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
type Snapshot = {
  selection: ContextSelection;
  captured: number;
  expires: number;
  last: number;
  monotonic: number;
  hash: string;
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
function check(snapshot: Snapshot): string {
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
  snapshots.set(context, snapshot);
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
  snapshots.delete(context);
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
