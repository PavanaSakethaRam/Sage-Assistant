/** Build-time only fixed native helper. Nothing downloads or compiles at runtime. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  stat,
  lstat,
} from "node:fs/promises";
import { resolve, join, dirname, isAbsolute, win32 } from "node:path";
import { fileURLToPath } from "node:url";

type Tool = { path: string; version: string; sha256: string };
type Toolchain = {
  compiler: Tool;
  msvc?: Tool;
  linker?: Tool;
  profdata?: Tool;
  cov?: Tool;
  runtime?: { path: string; sha256: string };
};
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function unavailable(): never {
  throw Error("Native installed toolchain unavailable");
}
async function removeOwned(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function rootProbeName(
  platform = process.platform,
  arch = process.arch,
): string {
  if (platform === "darwin" && arch === "arm64")
    return "root-probe-darwin-arm64";
  if (platform === "win32" && arch === "x64") return "root-probe-win32-x64.exe";
  throw Error("Unsupported root probe target");
}
function run(command: string, args: string[], cwd: string, limit = 65536) {
  const result = spawnSync(command, args, {
    shell: false,
    encoding: "utf8",
    input: "",
    cwd,
    timeout: 30000,
    maxBuffer: limit,
  });
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
      limit ||
    /\0/u.test(result.stdout + result.stderr)
  )
    unavailable();
  return { stdout: result.stdout, stderr: result.stderr };
}
async function fileHash(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || !info.size) unavailable();
  if (process.platform === "win32" && (await lstat(path)).isSymbolicLink())
    unavailable();
  return digest(await readFile(path));
}
async function tool(path: string, args: string[], cwd: string): Promise<Tool> {
  if (
    !(process.platform === "win32" ? win32.isAbsolute(path) : isAbsolute(path))
  )
    unavailable();
  const sha256 = await fileHash(path),
    output = run(path, args, cwd);
  if (args[0] !== "/?" && output.stderr) unavailable();
  const version = (output.stdout + output.stderr).trim();
  if (!version) unavailable();
  return { path, version, sha256 };
}
function llvmRelease(tool: Tool, windows: boolean): string {
  const release = /\b(?:clang|LLVM) version ([0-9]+\.[0-9]+\.[0-9]+)\b/u.exec(
    tool.version,
  )?.[1];
  if (
    !release ||
    /\b(?:error|warning|unknown)\b/iu.test(tool.version) ||
    (windows
      ? /Apple/iu.test(tool.version)
      : !/Apple (?:clang|LLVM) version/u.test(tool.version))
  )
    unavailable();
  return release;
}
async function installedTools(
  coverage: boolean,
  cwd: string,
): Promise<Toolchain> {
  rootProbeName();
  if (
    (process.env.RUNNER_OS &&
      process.env.RUNNER_OS !==
        (process.platform === "win32" ? "Windows" : "macOS")) ||
    (process.env.RUNNER_ARCH &&
      process.env.RUNNER_ARCH !==
        (process.platform === "win32" ? "X64" : "ARM64"))
  )
    unavailable();
  if (process.platform === "darwin") {
    const compiler = await tool("/usr/bin/clang", ["--version"], cwd);
    const release = llvmRelease(compiler, false);
    if (!/^Target: arm64-apple-darwin[0-9.]+$/mu.test(compiler.version))
      unavailable();
    if (!coverage) return { compiler };
    const locate = (name: string) => {
      const output = run("/usr/bin/xcrun", ["--find", name], cwd);
      const path = output.stdout.trim();
      if (output.stderr || !isAbsolute(path) || /[\r\n]/u.test(path))
        unavailable();
      return path;
    };
    const profdata = await tool(locate("llvm-profdata"), ["--version"], cwd);
    const cov = await tool(locate("llvm-cov"), ["--version"], cwd);
    const installed = /^InstalledDir: (.+)$/mu.exec(compiler.version)?.[1];
    if (
      llvmRelease(profdata, false) !== release ||
      llvmRelease(cov, false) !== release ||
      dirname(profdata.path) !== dirname(cov.path) ||
      installed !== dirname(cov.path)
    )
      unavailable();
    const builds = [compiler, profdata, cov]
      .map((t) => /\(clang-([^()]+)\)/u.exec(t.version)?.[1])
      .filter(Boolean);
    if (new Set(builds).size > 1) unavailable();
    return { compiler, profdata, cov };
  }
  const vc = process.env.VCToolsInstallDir;
  if (
    !vc ||
    !win32.isAbsolute(vc) ||
    process.env.VSCMD_ARG_HOST_ARCH !== "x64" ||
    process.env.VSCMD_ARG_TGT_ARCH !== "x64"
  )
    unavailable();
  const bin = win32.join(vc, "bin", "Hostx64", "x64");
  const msvc = await tool(win32.join(bin, "cl.exe"), ["/?"], cwd);
  const linker = await tool(win32.join(bin, "link.exe"), ["/?"], cwd);
  if (
    !/Microsoft \(R\) C\/C\+\+ Optimizing Compiler Version 19\.[0-9]+\.[0-9]+(?:\.[0-9]+)? for x64\b/u.test(
      msvc.version,
    ) ||
    !/Microsoft \(R\) Incremental Linker Version 14\.[0-9]+\.[0-9]+(?:\.[0-9]+)?\b/u.test(
      linker.version,
    ) ||
    /\b(?:error|warning) [A-Z]+[0-9]+/iu.test(msvc.version + linker.version)
  )
    unavailable();
  // The vendor shell and driver must resolve the same installed child linker.
  let selected: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(";")) {
    if (!win32.isAbsolute(directory)) continue;
    const candidate = win32.join(directory, "link.exe");
    try {
      if ((await stat(candidate)).isFile()) {
        selected = candidate;
        break;
      }
    } catch {
      /* absent PATH entry */
    }
  }
  if (
    !selected ||
    win32.normalize(selected).toLowerCase() !== linker.path.toLowerCase()
  )
    unavailable();
  if (!coverage) return { compiler: msvc, linker };
  const llvm = "C:\\Program Files\\LLVM\\bin";
  const compiler = await tool(
    win32.join(llvm, "clang-cl.exe"),
    ["--version"],
    cwd,
  );
  const profdata = await tool(
    win32.join(llvm, "llvm-profdata.exe"),
    ["--version"],
    cwd,
  );
  const cov = await tool(win32.join(llvm, "llvm-cov.exe"), ["--version"], cwd);
  const release = llvmRelease(compiler, true);
  if (
    llvmRelease(profdata, true) !== release ||
    llvmRelease(cov, true) !== release ||
    !/^Target: x86_64-pc-windows-msvc$/mu.test(compiler.version)
  )
    unavailable();
  const child = run(compiler.path, ["/clang:-print-prog-name=link"], cwd);
  if (
    child.stderr ||
    !win32.isAbsolute(child.stdout.trim()) ||
    win32.normalize(child.stdout.trim()).toLowerCase() !==
      linker.path.toLowerCase()
  )
    unavailable();
  const output = run(compiler.path, ["/clang:-print-runtime-dir"], cwd);
  const runtimeSpelling = output.stdout.trim(),
    runtimeDir = win32.normalize(runtimeSpelling);
  if (
    output.stderr ||
    !win32.isAbsolute(runtimeDir) ||
    /[\r\n]/u.test(runtimeDir) ||
    runtimeSpelling
      .split(/[\\/]/u)
      .some((part) => part === "." || part === "..") ||
    !runtimeDir.toLowerCase().startsWith("c:\\program files\\llvm\\") ||
    !(await stat(runtimeDir)).isDirectory()
  )
    unavailable();
  const path = win32.join(runtimeDir, "clang_rt.profile-x86_64.lib");
  return {
    compiler,
    msvc,
    linker,
    profdata,
    cov,
    runtime: { path, sha256: await fileHash(path) },
  };
}
function validateBinary(bytes: Buffer): void {
  if (process.platform === "darwin") {
    if (
      bytes.length < 32 ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== 0x0100000c
    )
      unavailable();
  } else {
    if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ")
      unavailable();
    const offset = bytes.readUInt32LE(0x3c);
    if (
      offset < 64 ||
      offset + 26 > bytes.length ||
      bytes.toString("ascii", offset, offset + 4) !== "PE\0\0" ||
      bytes.readUInt16LE(offset + 4) !== 0x8664 ||
      bytes.readUInt16LE(offset + 24) !== 0x20b
    )
      unavailable();
  }
}
export async function buildRootProbe(
  coverage = false,
): Promise<{ path: string; name: string; sha256: string }> {
  try {
    const name = rootProbeName(),
      dir = resolve(coverage ? ".cache/native-coverage" : ".cache/root-probe"),
      path = join(dir, name),
      source = resolve("extension/native/root-probe.c");
    await mkdir(dir, { recursive: true });
    await removeOwned(path);
    await removeOwned(join(dir, "provenance.json"));
    if (coverage)
      for (const file of await readdir(dir))
        if (
          /^run-[0-9]+-[0-9]+\.profraw$/u.test(file) ||
          ["coverage.profdata", "coverage.json"].includes(file)
        )
          await unlink(join(dir, file));
    const toolchain = await installedTools(coverage, dir);
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
            ...(coverage
              ? ["-fprofile-instr-generate", "-fcoverage-mapping"]
              : []),
            source,
            `/Fe:${path}`,
            `/Fo:${join(dir, "root-probe.obj")}`,
            "/link",
            "advapi32.lib",
          ];
    const sourceHash = await fileHash(source);
    const result = run(toolchain.compiler.path, flags, dir);
    if (
      result.stderr ||
      result.stdout
        .split(/\r?\n/u)
        .some(
          (line) =>
            line && !(process.platform === "win32" && line === "root-probe.c"),
        )
    )
      unavailable();
    const bytes = await readFile(path);
    validateBinary(bytes);
    if (sourceHash !== (await fileHash(source))) unavailable();
    for (const entry of Object.values(toolchain))
      if (entry.sha256 !== (await fileHash(entry.path))) unavailable();
    const sha256 = digest(bytes);
    await writeFile(
      join(dir, "provenance.json"),
      JSON.stringify(
        {
          compiler: toolchain.compiler.path,
          version: toolchain.compiler.version,
          flags,
          target: `${process.platform}-${process.arch}`,
          source_sha256: sourceHash,
          sha256,
          size: bytes.length,
          coverage,
          toolchain,
        },
        null,
        2,
      ),
    );
    return { path, name, sha256 };
  } catch {
    throw Error("Native root probe build failed");
  }
}
function validateCoverage(data: unknown, source: string): void {
  const packet = data as {
    type?: unknown;
    version?: unknown;
    data?: {
      files?: {
        filename?: unknown;
        summary?: Record<string, { count?: unknown; covered?: unknown }>;
      }[];
    }[];
  };
  if (
    !packet ||
    packet.type !== "llvm.coverage.json.export" ||
    (packet.version !== "2.0.1" && packet.version !== "3.0.1") ||
    !Array.isArray(packet.data) ||
    packet.data.length !== 1 ||
    !Array.isArray(packet.data[0].files) ||
    packet.data[0].files.length !== 1
  )
    unavailable();
  const file = packet.data[0].files[0];
  if (file.filename !== source) unavailable();
  for (const [metric, threshold] of [
    ["regions", 90],
    ["branches", 85],
  ] as const) {
    const summary = file.summary?.[metric],
      total = summary?.count,
      covered = summary?.covered;
    if (
      typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      total <= 0 ||
      typeof covered !== "number" ||
      !Number.isSafeInteger(covered) ||
      covered < 0 ||
      covered > total ||
      covered * 100 < total * threshold
    )
      unavailable();
  }
}
export async function reportNativeCoverage(): Promise<void> {
  try {
    const dir = resolve(".cache/native-coverage"),
      binary = join(dir, rootProbeName()),
      source = resolve("extension/native/root-probe.c");
    await removeOwned(join(dir, "coverage.json"));
    await removeOwned(join(dir, "coverage.profdata"));
    const toolchain = await installedTools(true, dir);
    const provenance = JSON.parse(
      await readFile(join(dir, "provenance.json"), "utf8"),
    );
    const sourceHash = await fileHash(source),
      binaryHash = await fileHash(binary);
    validateBinary(await readFile(binary));
    if (
      provenance.source_sha256 !== sourceHash ||
      provenance.sha256 !== binaryHash ||
      provenance.coverage !== true ||
      provenance.target !== `${process.platform}-${process.arch}` ||
      provenance.compiler !== toolchain.compiler.path ||
      provenance.version !== toolchain.compiler.version ||
      JSON.stringify(provenance.toolchain) !== JSON.stringify(toolchain)
    )
      unavailable();
    const profiles = (await readdir(dir))
      .filter((name) => /^run-[0-9]+-[0-9]+\.profraw$/u.test(name))
      .sort()
      .map((name) => join(dir, name));
    if (!profiles.length) unavailable();
    const hashes: Record<string, string> = {};
    const binaryTime = (await stat(binary)).mtimeMs;
    for (const path of profiles) {
      if (
        !(await lstat(path)).isFile() ||
        (await stat(path)).mtimeMs < binaryTime
      )
        unavailable();
      hashes[path] = await fileHash(path);
    }
    const merged = join(dir, "coverage.profdata");
    const merge = run(
      toolchain.profdata!.path,
      ["merge", "-sparse", ...profiles, "-o", merged],
      dir,
    );
    if (merge.stdout || merge.stderr) unavailable();
    const mergedHash = await fileHash(merged);
    const exported = run(
      toolchain.cov!.path,
      ["export", binary, `-instr-profile=${merged}`],
      dir,
      1048576,
    );
    if (exported.stderr) unavailable();
    const coverage: unknown = JSON.parse(exported.stdout);
    validateCoverage(coverage, source);
    if (
      sourceHash !== (await fileHash(source)) ||
      binaryHash !== (await fileHash(binary)) ||
      mergedHash !== (await fileHash(merged))
    )
      unavailable();
    for (const [path, sha256] of Object.entries(hashes))
      if (sha256 !== (await fileHash(path))) unavailable();
    for (const entry of Object.values(toolchain))
      if (entry.sha256 !== (await fileHash(entry.path))) unavailable();
    await writeFile(
      join(dir, "coverage.json"),
      JSON.stringify({
        version: 1,
        platform: `${process.platform}-${process.arch}`,
        source_sha256: { "extension/native/root-probe.c": sourceHash },
        binary_sha256: binaryHash,
        profile_sha256: hashes,
        merged_sha256: mergedHash,
        toolchain,
        coverage,
      }),
    );
  } catch {
    throw Error("Native coverage report failed");
  }
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
    rootProbeName();
    const result = spawnSync(
      process.execPath,
      [
        resolve("node_modules/vitest/vitest.mjs"),
        "run",
        "extension/test/unit/root-probe.test.ts",
        "--maxWorkers=1",
      ],
      {
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, SAGE_NATIVE_COVERAGE: "1" },
        timeout: 120000,
      },
    );
    if (result.error || result.signal || result.status !== 0)
      throw Error("Native coverage fixtures failed");
    await reportNativeCoverage();
  } else if (mode === "--report-coverage") await reportNativeCoverage();
  else await buildRootProbe(mode === "--coverage");
}
