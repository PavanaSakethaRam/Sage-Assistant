/** Actual embedded editor and shipped helper fixtures, only inside the owned test host. */
import * as vscode from "vscode";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localWorkspace } from "../../src/bridge";
import {
  captureContext,
  releaseContext,
  validateContext,
  type ContextSelection,
} from "../../src/context";
import { probeRoot } from "../../src/root-probe";
import { rootIdentity } from "../../../desktop/shared/editor-bridge";
export async function runContextFixture(
  extensionPath: string,
  fixture: string,
): Promise<Record<string, unknown>> {
  const raw = vscode.workspace.workspaceFolders![0].uri.toString(),
    root = fileURLToPath(raw),
    storage = join(fixture, "probe-storage");
  await mkdir(storage);
  const guard = () => {
    assert.equal(vscode.workspace.isTrusted, true);
    assert.equal(vscode.workspace.workspaceFolders![0].uri.toString(), raw);
    assert.equal(vscode.env.remoteName, undefined);
  };
  const identity = await probeRoot(root, extensionPath, storage, guard);
  const workspace = localWorkspace(
    {
      trusted: true,
      remoteName: undefined,
      uiKind: "desktop",
      folders: [{ uri: raw }],
    },
    "native-window",
  );
  const pair = {
    ...workspace,
    root_id: rootIdentity(workspace),
    pair_id: "native-pair",
    host_boot_id: "native-boot",
    challenge: "fixture",
    status: "paired" as const,
  };
  const base: ContextSelection = {
    pair,
    binding: {
      job_id: "native-job",
      boot_id: pair.host_boot_id,
      pair_id: pair.pair_id,
      window_id: pair.window_id,
      root_id: pair.root_id,
      revision: 1,
      policy_version: "code-v1",
    },
    generation: 0,
    rawRootUri: raw,
    nativeIdentity: identity,
    extensionPath,
    storagePath: storage,
    mode: "replace_focus_file",
    target: "focus.js",
    names: ["focus.js"],
    diagnosticIds: [],
    guard,
  };
  const source = "export const nativeMarker = '😀';\n";
  const path = join(root, "focus.js");
  await writeFile(path, source);
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(path),
  );
  assert.equal(document.getText(), source);
  assert.equal(document.isDirty, false);
  assert.equal(document.eol, vscode.EndOfLine.LF);
  await assert.rejects(
    captureContext({
      ...base,
      rawRootUri: raw.replace(/\/([^/]+)$/u, "/unused/../$1"),
    }),
  );
  await assert.rejects(
    captureContext({
      ...base,
      rawRootUri: raw.replace(/\/([^/]+)$/u, "/unused/%2e%2e/$1"),
    }),
  );
  const captured = await captureContext(base);
  await validateContext(captured);
  assert.equal(captured.files[0].document_version, document.version);
  assert.equal(captured.files[0].text, source);
  assert.equal(
    captured.files[0].disk_hash,
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  );
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), "dirty ");
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  assert.equal(document.isDirty, true);
  await assert.rejects(validateContext(captured));
  await assert.rejects(captureContext(base));
  assert.equal(await readFile(path, "utf8"), source);
  // Keep the dirty owned model unsaved until this disposable host is stopped.
  const other = join(root, "README.md");
  for (const bytes of [
    Buffer.from("a\r\nb"),
    Buffer.from("\ufeffa"),
    Buffer.from([0xff]),
  ]) {
    await writeFile(other, bytes);
    await assert.rejects(
      captureContext({ ...base, target: "README.md", names: ["README.md"] }),
    );
  }
  await rm(other);
  await symlink(path, other);
  await assert.rejects(
    captureContext({ ...base, target: "README.md", names: ["README.md"] }),
  );
  await rm(other);
  const drift = join(fixture, "drift");
  await mkdir(join(drift, "dist"), { recursive: true });
  const helper =
    process.platform === "darwin"
      ? "root-probe-darwin-arm64"
      : "root-probe-win32-x64.exe";
  await copyFile(
    join(extensionPath, "dist", helper),
    join(drift, "dist", helper),
  );
  await writeFile(join(drift, "dist", helper), "drift");
  await assert.rejects(probeRoot(root, drift, storage, guard));
  await assert.rejects(
    probeRoot(root, join(fixture, "missing"), storage, guard),
  );
  const alias = join(fixture, "root-alias");
  await symlink(root, alias);
  await assert.rejects(probeRoot(alias, extensionPath, storage, guard));
  await rename(root, root + "-replaced");
  await mkdir(root);
  await assert.rejects(
    captureContext({
      ...base,
      mode: "create_focus_project",
      target: undefined,
      names: [],
    }),
  );
  await rmdir(root);
  await rename(root + "-replaced", root);
  releaseContext(captured);
  return {
    native_identity: identity,
    raw_folder_uri: raw,
    canonical_folder_uri: workspace.root_uri,
    colon_folder_codec: root.includes("workspace:context"),
    dot_segment_refused: true,
    source_utf8_bytes: Buffer.byteLength(source),
    source_codepoints: [...source].length,
    document_version: document.version,
    snapshot_version: captured.files[0].document_version,
    disk_sha256: captured.files[0].disk_hash,
    unchanged_disk_after_dirty: true,
    crlf_bom_invalid_utf8_refused: true,
    symlink_refused: true,
    root_switch_refused: true,
    helper_drift_missing_refused: true,
  };
}
