/** Build-time only fixed native helper. Nothing downloads or compiles at runtime. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
export function rootProbeName(
  platform = process.platform,
  arch = process.arch,
): string {
  if (platform === "darwin" && arch === "arm64")
    return "root-probe-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "root-probe-win32-x64.exe";
  throw Error("Unsupported root probe target");
}
export async function buildRootProbe(
  coverage = false,
): Promise<{ path: string; name: string; sha256: string }> {
  const name = rootProbeName(),
    dir = resolve(coverage ? ".cache/native-coverage" : ".cache/root-probe"),
    path = join(dir, name),
    source = resolve("extension/native/root-probe.c");
  await mkdir(dir, { recursive: true });
  if (coverage)
    for (const file of await readdir(dir))
      if (
        /^run-[0-9]+-[0-9]+\.profraw$/.test(file) ||
        ["coverage.profdata", "coverage.json"].includes(file)
      )
        await unlink(join(dir, file));
  const compiler = process.platform === "darwin" ? "/usr/bin/clang" : "cl.exe";
  const flags =
    process.platform === "darwin"
      ? [
          "-std=c11",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-O2",
          "-arch",
          "arm64",
          ...(coverage
            ? ["-fprofile-instr-generate", "-fcoverage-mapping"]
            : []),
          source,
          "-o",
          path,
        ]
      : [
          "/nologo",
          "/W4",
          "/WX",
          "/O2",
          "/TC",
          source,
          `/Fe:${path}`,
          `/Fo:${join(dir, "root-probe.obj")}`,
          "/link",
          "advapi32.lib",
        ];
  if (coverage && process.platform !== "darwin")
    throw Error("Native coverage requires supported installed tooling");
  const version = spawnSync(
    compiler,
    process.platform === "darwin" ? ["--version"] : [],
    { shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
  );
  const result = spawnSync(compiler, flags, {
    shell: false,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 65536,
  });
  if (result.status !== 0)
    throw Error(`Native root probe build failed: ${result.stderr}`);
  const bytes = await readFile(path);
  if (
    process.platform === "darwin"
      ? bytes.readUInt32LE(0) !== 0xfeedfacf ||
        bytes.readUInt32LE(4) !== 0x0100000c
      : bytes.toString("ascii", 0, 2) !== "MZ" ||
        bytes.readUInt16LE(bytes.readUInt32LE(0x3c) + 4) !== 0x8664
  )
    throw Error("Root probe artifact target drift");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(dir, "provenance.json"),
    JSON.stringify(
      {
        compiler,
        version: version.stdout || version.stderr,
        flags,
        target: `${process.platform}-${process.arch}`,
        source_sha256: createHash("sha256")
          .update(await readFile(source))
          .digest("hex"),
        sha256,
        size: bytes.length,
        coverage,
      },
      null,
      2,
    ),
  );
  return { path, name, sha256 };
}
export async function reportNativeCoverage(): Promise<void> {
  const dir = resolve(".cache/native-coverage"),
    binary = join(dir, rootProbeName());
  const provenance = JSON.parse(
    await readFile(join(dir, "provenance.json"), "utf8"),
  );
  const sourceHash = createHash("sha256")
    .update(await readFile(resolve("extension/native/root-probe.c")))
    .digest("hex");
  const binaryHash = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  if (
    provenance.source_sha256 !== sourceHash ||
    provenance.sha256 !== binaryHash ||
    provenance.coverage !== true
  )
    throw Error("Native coverage artifact drift");
  const profiles = (await readdir(dir))
    .filter((name) => /^run-[0-9]+-[0-9]+\.profraw$/.test(name))
    .map((name) => join(dir, name));
  if (!profiles.length) throw Error("Missing native coverage profiles");
  const merged = spawnSync(
    "/usr/bin/xcrun",
    [
      "llvm-profdata",
      "merge",
      "-sparse",
      ...profiles,
      "-o",
      join(dir, "coverage.profdata"),
    ],
    { shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 65536 },
  );
  if (merged.status !== 0 || merged.stderr)
    throw Error("Native coverage merge failed");
  const exported = spawnSync(
    "/usr/bin/xcrun",
    [
      "llvm-cov",
      "export",
      binary,
      `-instr-profile=${join(dir, "coverage.profdata")}`,
    ],
    { shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
  );
  if (exported.status !== 0 || exported.stderr)
    throw Error("Native coverage export failed");
  await writeFile(
    join(dir, "coverage.json"),
    JSON.stringify({
      version: 1,
      platform: `${process.platform}-${process.arch}`,
      source_sha256: { "extension/native/root-probe.c": sourceHash },
      binary_sha256: binaryHash,
      coverage: JSON.parse(exported.stdout),
    }),
  );
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const mode = process.argv[2];
  if (
    process.argv.length > 3 ||
    (mode &&
      !["--coverage", "--report-coverage", "--test-coverage"].includes(mode))
  )
    throw Error("Unknown probe build argument");
  if (mode === "--test-coverage") {
    if (process.platform !== "darwin" || process.arch !== "arm64")
      throw Error("Native platform coverage gate unavailable");
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "extension/test/unit/root-probe.test.ts",
      ],
      {
        shell: false,
        stdio: "inherit",
        env: { ...process.env, SAGE_NATIVE_COVERAGE: "1" },
        timeout: 120000,
      },
    );
    if (result.status !== 0) throw Error("Native coverage fixtures failed");
    await reportNativeCoverage();
  } else if (mode === "--report-coverage") await reportNativeCoverage();
  else await buildRootProbe(mode === "--coverage");
}
