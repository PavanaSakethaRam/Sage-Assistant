/** Inspect the actual ASAR, production fuse wire, and external resource baseline. */
import {
  extractFile,
  getRawHeader,
  listPackage,
  statFile,
  uncache,
} from "@electron/asar";
import { getCurrentFuseWire, FuseV1Options } from "@electron/fuses";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
export async function validateVsix(archive: string): Promise<string[]> {
  const source = new Map([
    ["extension/package.json", "extension/package.json"],
    ["extension/dist/extension.cjs", "extension/dist/extension.cjs"],
    ["extension/readme.md", "extension/README.md"],
    ["extension/LICENSE.txt", "extension/LICENSE"],
    ["extension/THIRD_PARTY_NOTICES.md", "extension/THIRD_PARTY_NOTICES.md"],
  ]);
  const allowed = new Set([
    ...source.keys(),
    "[Content_Types].xml",
    "extension.vsixmanifest",
  ]);
  const expected: Record<string, string> = {};
  for (const [name, path] of source)
    expected[name] = createHash("sha256")
      .update(await readFile(resolve(path)))
      .digest("hex");
  const python = resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const check = `import sys,json,zipfile,hashlib,stat,os
archive,expected=sys.argv[1],json.loads(sys.argv[2])
assert os.path.getsize(archive)<=2097152
with zipfile.ZipFile(archive) as z:
 items=z.infolist(); names=[i.filename for i in items]
 assert len(names)==len(set(names))==7
 assert set(names)==set(expected)|{'[Content_Types].xml','extension.vsixmanifest'}
 for i in items:
  assert i.file_size<=1048576 and not stat.S_ISLNK(i.external_attr>>16) and not i.flag_bits&1
  data=z.read(i)
  if i.filename in expected: assert hashlib.sha256(data).hexdigest()==expected[i.filename]
 print(json.dumps(sorted(names)))`;
  // Only fixed local archive/source bytes reach the existing stdlib ZIP checker.
  const result = spawnSync(
    python,
    ["-c", check, archive, JSON.stringify(expected)],
    { shell: false, encoding: "utf8", maxBuffer: 262144, timeout: 30_000 },
  );
  if (result.status !== 0) throw Error("Unsafe VSIX");
  const manifest = JSON.parse(
    (await readFile(resolve("extension/package.json"))).toString(),
  );
  if (
    manifest.main !== "./dist/extension.cjs" ||
    manifest.publisher !== "sage-local" ||
    manifest.dependencies ||
    manifest.devDependencies ||
    (await readFile(resolve("extension/dist/extension.cjs"))).includes(
      Buffer.from("sourceMappingURL"),
    )
  )
    throw Error("Unsafe VSIX runtime");
  const entries: unknown = JSON.parse(result.stdout);
  if (
    !Array.isArray(entries) ||
    entries.some((name) => typeof name !== "string" || !allowed.has(name))
  )
    throw Error("Invalid VSIX inventory");
  return entries as string[];
}
async function main(): Promise<void> {
  if (process.argv[2] === "--vsix") {
    if (process.argv.length !== 4) throw Error("Invalid VSIX arguments");
    console.log(
      JSON.stringify({
        status: "pass",
        entries: await validateVsix(resolve(process.argv[3])),
      }),
    );
    return;
  }
  const app = resolve(process.argv[2]);
  const resources =
    process.platform === "darwin"
      ? join(app, "Contents/Resources")
      : join(app, "resources");
  const archive = join(resources, "app.asar");
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
  const python = resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const result = spawnSync(
    python,
    [
      "scripts/package_manifest.py",
      resources,
      "--manifest",
      resolve(process.argv[3]),
      "--packaged",
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.status !== 0) throw Error("External resource mismatch");
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
