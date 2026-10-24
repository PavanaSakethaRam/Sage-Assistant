/** Inspect the actual ASAR, production fuse wire, and external resource baseline. */
import {
  extractFile,
  getRawHeader,
  listPackage,
  statFile,
  uncache,
} from "@electron/asar";
import { getCurrentFuseWire, FuseV1Options } from "@electron/fuses";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateVsix } from "./check_extension.mjs";
import {
  compiledExtensionIdentity,
  type ExtensionIdentity,
  ordinaryPath,
  readExtensionIdentity,
} from "../desktop/main/extension-export.ts";
export { validateVsix } from "./check_extension.mjs";

export function canonicalArchiveEntry(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // @electron/asar lists header paths through node:path.join, which uses
  // backslashes on Windows. Keep the raw path for stat/extract operations.
  return platform === "win32" ? name.replaceAll("\\", "/") : name;
}

export function validateRawArchiveHeader(header: unknown): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown, parents: string[]): void => {
    if (typeof node !== "object" || node === null || !("files" in node))
      throw Error("Unsafe application archive");
    const files = node.files;
    if (typeof files !== "object" || files === null || Array.isArray(files))
      throw Error("Unsafe application archive");
    for (const [part, entry] of Object.entries(files)) {
      // Check header components before path.join can flatten Windows aliases.
      if (!part || part === "." || part === ".." || /[\\/\0]/u.test(part))
        throw Error("Unsafe application archive");
      const path = `/${[...parents, part].join("/")}`;
      const canonical = canonicalArchiveEntry(path);
      if (names.has(canonical)) throw Error("Unsafe application archive");
      names.add(canonical);
      if (typeof entry !== "object" || entry === null)
        throw Error("Unsafe application archive");
      if ("files" in entry) walk(entry, [...parents, part]);
    }
  };
  walk(header, []);
  return names;
}

export function validateArchive(archive: string): void {
  uncache(archive);
  const headerNames = validateRawArchiveHeader(getRawHeader(archive).header);
  const listedNames = new Set<string>();
  const directories = new Set([
    "/.vite",
    "/.vite/build",
    "/.vite/renderer",
    "/.vite/renderer/main_window",
    "/.vite/renderer/main_window/assets",
  ]);
  const entries = new Set([
    "/package.json",
    "/.vite/build/main.cjs",
    "/.vite/build/preload.cjs",
    "/.vite/renderer/main_window/index.html",
  ]);
  for (const rawName of listPackage(archive, { isPack: false })) {
    const name = canonicalArchiveEntry(rawName);
    if (!headerNames.has(name) || listedNames.has(name))
      throw Error("Unsafe application archive");
    listedNames.add(name);
    const entry = statFile(archive, rawName.slice(1), false);
    if ("link" in entry || entry.unpacked)
      throw Error("Unsafe application archive");
    if ("files" in entry) {
      if (!directories.has(name)) throw Error("Unsafe application archive");
      continue;
    }
    if (
      !entries.has(name) &&
      !/^\/\.vite\/renderer\/main_window\/assets\/index-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(
        name,
      )
    )
      throw Error("Unsafe application archive");
    const content = extractFile(archive, rawName.slice(1)).toString("utf8");
    if (
      /__sageE2E|FakeReasoner|e2e\/fixtures|events\.jsonl|full\.once|egress_probe/.test(
        content,
      ) ||
      /\bgh[opusr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
        content,
      )
    )
      throw Error("Unsafe application archive");
  }
  if (listedNames.size !== headerNames.size)
    throw Error("Unsafe application archive");
}
export interface CheckedPackage extends ExtensionIdentity {
  app: string;
  resources: string;
  archive: string;
  core: string;
  vsix: string;
  bundleSha256: string;
}
export async function validatePackage(
  app: string,
  manifest: string,
): Promise<CheckedPackage> {
  ordinaryPath(app, true);
  ordinaryPath(manifest, false);
  const baseline: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  if (
    typeof baseline !== "object" ||
    baseline === null ||
    Array.isArray(baseline) ||
    Object.keys(baseline).sort().join(",") !== "entries,schema" ||
    !("schema" in baseline) ||
    baseline.schema !== 1 ||
    !("entries" in baseline) ||
    typeof baseline.entries !== "object" ||
    baseline.entries === null ||
    Array.isArray(baseline.entries)
  )
    throw Error("Invalid resource manifest");
  for (const [name, row] of Object.entries(baseline.entries)) {
    if (
      !name ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\\0:]/u.test(name) ||
      typeof row !== "object" ||
      row === null ||
      Array.isArray(row) ||
      !Number.isInteger(row.mode) ||
      row.mode < 0 ||
      row.mode > 0o7777 ||
      (row.type === "file"
        ? Object.keys(row).sort().join(",") !== "bytes,mode,sha256,type" ||
          !Number.isInteger(row.bytes) ||
          row.bytes < 0 ||
          typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(row.sha256)
        : row.type !== "symlink" ||
          Object.keys(row).sort().join(",") !== "mode,target,type" ||
          typeof row.target !== "string")
    )
      throw Error("Invalid resource manifest");
  }
  const resources =
    process.platform === "darwin"
      ? join(app, "Contents/Resources")
      : join(app, "resources");
  const archive = join(resources, "app.asar");
  ordinaryPath(resources, true);
  ordinaryPath(archive, false);
  validateArchive(archive);
  const entries = listPackage(archive, { isPack: false }).map((name) =>
    canonicalArchiveEntry(name),
  );
  for (const required of [
    "/.vite/build/main.cjs",
    "/.vite/build/preload.cjs",
    "/.vite/renderer/main_window/index.html",
  ])
    if (!entries.includes(required)) throw Error("Missing application entry");
  const wire = await getCurrentFuseWire(
    process.platform === "darwin" ? app : join(app, "Sage.exe"),
  );
  for (const option of [
    FuseV1Options.RunAsNode,
    FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    FuseV1Options.EnableNodeCliInspectArguments,
  ])
    if (wire[option] !== 48) throw Error("Unsafe production fuse");
  for (const option of [
    FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    FuseV1Options.OnlyLoadAppFromAsar,
  ])
    if (wire[option] !== 49) throw Error("Missing production fuse");
  const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const python = resolve(
    project,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const result = spawnSync(
    python,
    [
      join(project, "scripts/package_manifest.py"),
      resources,
      "--manifest",
      manifest,
      "--packaged",
    ],
    {
      cwd: project,
      stdio: "pipe",
      shell: false,
      timeout: 30_000,
      maxBuffer: 16_384,
    },
  );
  if (result.status !== 0) throw Error("External resource mismatch");
  const identity = readExtensionIdentity(
    join(dirname(manifest), "editor-extension.json"),
    resources,
  );
  const compiled = compiledExtensionIdentity(
    extractFile(archive, ".vite/build/main.cjs").toString("utf8"),
  );
  if (
    identity === null ||
    JSON.stringify(identity) !== JSON.stringify(compiled)
  )
    throw Error("Packaged extension identity mismatch");
  const vsix = join(resources, "editor-extension/sage-editor-bridge.vsix");
  const checked = await validateVsix(vsix);
  if (checked.sha256 !== identity.sha256)
    throw Error("Packaged extension changed");
  return {
    app,
    resources,
    archive,
    core: join(
      resources,
      "core",
      process.platform === "win32" ? "sage-core.exe" : "sage-core",
    ),
    vsix,
    ...identity,
    bundleSha256: checked.bundleSha256,
  };
}
async function main(): Promise<void> {
  if (process.argv[2] === "--vsix") {
    if (process.argv.length !== 4) throw Error("Invalid VSIX arguments");
    console.log(
      JSON.stringify({
        status: "pass",
        ...(await validateVsix(resolve(process.argv[3]))),
      }),
    );
    return;
  }
  if (process.argv.length !== 4) throw Error("Invalid package arguments");
  await validatePackage(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log("PASS actual ASAR, production fuses and resource baseline");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    console.error("FAIL package checks");
    process.exitCode = 1;
  });
}
