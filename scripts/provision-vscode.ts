/** Separate network provisioning; deterministic tests only revalidate the recorded cache. */
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const VERSION = "1.143.1";
export const COMMIT = "e646868227c3e3a9e3f24277c8c7220be42c0be7";
export function platformName(
  platform = process.platform,
  arch = process.arch,
): string {
  if (
    !["darwin", "win32"].includes(platform) ||
    !["arm64", "x64"].includes(arch)
  )
    throw Error("Unvalidated editor platform");
  return platform === "darwin"
    ? arch === "arm64"
      ? "darwin-arm64"
      : "darwin"
    : `win32-${arch}-archive`;
}
export const CACHE = resolve(
  ".cache/vscode",
  `${VERSION}-${process.platform}-${process.arch}`,
);
type Entry = {
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  size?: number;
  sha256?: string;
  target?: string;
};
export async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const canonical = await realpath(root);
  async function walk(parent: string): Promise<void> {
    for (const name of (await readdir(parent)).sort()) {
      const path = join(parent, name),
        item = relative(root, path).split(sep).join("/");
      if (item === "provenance.json") continue;
      const stat = await lstat(path);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        const target = await readlink(path);
        const actual = await realpath(path);
        if (actual !== canonical && !actual.startsWith(canonical + sep))
          throw Error("Editor cache symlink escape");
        entries.push({ path: item, type: "symlink", mode, target });
      } else if (stat.isDirectory()) {
        entries.push({ path: item, type: "directory", mode });
        await walk(path);
      } else if (stat.isFile()) {
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        entries.push({
          path: item,
          type: "file",
          mode,
          size: stat.size,
          sha256: hash.digest("hex"),
        });
      } else throw Error("Unsupported editor cache entry");
    }
  }
  await walk(root);
  return entries;
}
export async function revalidate(cache = CACHE): Promise<string> {
  const record = JSON.parse(
    await readFile(join(cache, "provenance.json"), "utf8"),
  );
  if (
    record.version !== VERSION ||
    record.commit !== COMMIT ||
    record.platform !== platformName() ||
    typeof record.executable !== "string" ||
    JSON.stringify(record.inventory) !== JSON.stringify(await inventory(cache))
  )
    throw Error("Editor cache missing or drifted; provision separately");
  const executable = resolve(cache, record.executable);
  if (!executable.startsWith(cache + sep))
    throw Error("Invalid editor executable");
  return executable;
}
async function main(): Promise<void> {
  const platform = platformName();
  await mkdir(resolve(".cache/vscode"), { recursive: true });
  // Exclusive directory creation prevents a helper cache marker from replacing provenance.
  await mkdir(CACHE);
  const response = await fetch(
    `https://update.code.visualstudio.com/api/versions/${VERSION}/${platform}/stable`,
  );
  if (!response.ok) throw Error("Microsoft editor metadata unavailable");
  const metadata = (await response.json()) as {
    version?: string;
    productVersion?: string;
  };
  if (metadata.version !== COMMIT || metadata.productVersion !== VERSION)
    throw Error("Microsoft editor metadata disagrees with pinned target");
  const executable = await downloadAndUnzipVSCode({
    version: VERSION,
    platform,
    cachePath: CACHE,
    timeout: 30_000,
  });
  const record = {
    version: VERSION,
    commit: COMMIT,
    platform,
    provisioned_at: new Date().toISOString(),
    metadata,
    executable: relative(CACHE, executable).split(sep).join("/"),
    integrity_limit:
      "Helper checks Content-Length and conditional x-sha256 before extraction; no required/expected checksum option, no comparison with JSON metadata sha256hash, no retained archive, no independent authenticated archive verification.",
    inventory: await inventory(CACHE),
  };
  await writeFile(
    join(CACHE, "provenance.json"),
    JSON.stringify(record, null, 2) + "\n",
    { flag: "wx" },
  );
  await revalidate();
  console.log(
    JSON.stringify({
      status: "provisioned",
      version: VERSION,
      commit: COMMIT,
      platform,
      entries: record.inventory.length,
      cache: CACHE,
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "FAIL editor provisioning; preserve failed owned cache for inspection",
    );
    process.exitCode = 1;
  });
