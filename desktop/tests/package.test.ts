import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPackage } from "@electron/asar";
import { MakerZIP } from "@electron-forge/maker-zip";
import { expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  createWindowsZip,
  WindowsSafeMakerZIP,
} from "../../scripts/windows-zip-maker";

async function productionLayout(root: string) {
  const files = {
    "package.json": '{"name":"synthetic"}',
    ".vite/build/main.cjs": "module.exports = {};",
    ".vite/build/preload.cjs": "module.exports = {};",
    ".vite/renderer/main_window/index.html": "<!doctype html><html></html>",
    ".vite/renderer/main_window/assets/index-Abc12345.js":
      "console.log('synthetic');",
    ".vite/renderer/main_window/assets/index-Abc12345.css":
      "body { margin: 0; }",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
}

test("release makers produce only portable ZIPs on macOS and Windows", async () => {
  const { default: config } = await import("../../forge.config");
  expect(config.makers).toHaveLength(1);
  const maker = config.makers?.[0];
  expect(maker).toBeInstanceOf(MakerZIP);
  if (!(maker instanceof MakerZIP))
    throw new Error("Expected portable ZIP maker");
  expect(maker.platforms).toEqual(["darwin", "win32"]);
  expect(maker).toBeInstanceOf(WindowsSafeMakerZIP);
});

test("Windows ZIP command passes special paths as data and hides child diagnostics", async () => {
  const source = "C:\\synthetic & $' source\\app";
  const destination = "C:\\synthetic & $' output\\app.zip";
  let invocation:
    { file: string; args: readonly string[]; options: object } | undefined;
  const child = new EventEmitter() as ChildProcess;
  const launch: Parameters<typeof createWindowsZip>[2] = (
    file,
    args,
    options,
  ) => {
    invocation = { file, args, options };
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
  await createWindowsZip(source, destination, launch);
  expect(invocation?.file).toBe("powershell.exe");
  expect(invocation?.args.slice(-4)).toEqual([
    "-Source",
    source,
    "-Destination",
    destination,
  ]);
  expect(invocation?.args).toContain("-File");
  expect(invocation?.args).not.toContain("-Command");
  expect(invocation?.options).toMatchObject({
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
});

test.each(["exit", "start", "timeout"])(
  "Windows ZIP %s failure stays closed and bounded",
  async (failure) => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    const launch: Parameters<typeof createWindowsZip>[2] = () => {
      if (failure !== "timeout")
        queueMicrotask(() =>
          failure === "exit"
            ? child.emit("close", 7)
            : child.emit("error", new Error("synthetic private path")),
        );
      return child;
    };
    await expect(
      createWindowsZip("C:\\private", "C:\\private.zip", launch, 10),
    ).rejects.toThrow(`Windows ZIP creation failed: ${failure}`);
  },
);

test.skipIf(process.platform !== "win32")(
  "real Windows maker archives hidden files and special paths with Forge layout",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sage-zip-test-"));
    const dir = join(root, "Sage & $' special");
    const makeDir = join(root, "result & $' special");
    try {
      await mkdir(join(dir, "nested"), { recursive: true });
      await writeFile(join(dir, ".hidden"), "dot file");
      await writeFile(join(dir, "nested", "body.txt"), "nested body");
      const maker = new WindowsSafeMakerZIP({}, ["darwin", "win32"]);
      const artifacts = await maker.make({
        dir,
        makeDir,
        appName: "Sage",
        targetPlatform: "win32",
        targetArch: "x64",
        packageJSON: { version: "0.1.0" },
      } as Parameters<WindowsSafeMakerZIP["make"]>[0]);
      const archive = resolve(
        makeDir,
        "zip",
        "win32",
        "x64",
        "Sage & $' special-0.1.0.zip",
      );
      expect(artifacts).toEqual([archive]);
      const python = resolve(".venv/Scripts/python.exe");
      const entries = JSON.parse(
        execFileSync(
          python,
          [
            "-I",
            "-c",
            "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({n:z.read(n).decode('utf-8') for n in z.namelist() if not n.endswith('/')}))",
            archive,
          ],
          { encoding: "utf8", timeout: 10_000 },
        ),
      ) as Record<string, string>;
      expect(entries[".hidden"]).toBe("dot file");
      expect(entries["nested/body.txt"]).toBe("nested body");
      await writeFile(join(dir, "nested", "body.txt"), "replacement");
      expect(
        await maker.make({
          dir,
          makeDir,
          appName: "Sage",
          targetPlatform: "win32",
          targetArch: "x64",
          packageJSON: { version: "0.1.0" },
        } as Parameters<WindowsSafeMakerZIP["make"]>[0]),
      ).toEqual([archive]);
      const replaced = execFileSync(
        python,
        [
          "-I",
          "-c",
          "import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read('nested/body.txt').decode())",
          archive,
        ],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(replaced.trim()).toBe("replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  // Two 120s production ZIP deadlines + two 10s inspections + 10s cleanup margin.
  270_000,
);

test.skipIf(process.platform !== "darwin")(
  "macOS maker retains inherited ZIP layout",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sage-mac-zip-test-"));
    const dir = join(root, "Sage-darwin-arm64");
    const makeDir = join(root, "make");
    try {
      await mkdir(join(dir, "Sage.app"), { recursive: true });
      await writeFile(join(dir, "Sage.app", ".hidden"), "dot file");
      const maker = new WindowsSafeMakerZIP({}, ["darwin", "win32"]);
      await maker.prepareConfig("arm64");
      const artifacts = await maker.make({
        dir,
        makeDir,
        appName: "Sage",
        targetPlatform: "darwin",
        targetArch: "arm64",
        packageJSON: { version: "0.1.0" },
      } as Parameters<WindowsSafeMakerZIP["make"]>[0]);
      const archive = resolve(
        makeDir,
        "zip",
        "darwin",
        "arm64",
        "Sage-darwin-arm64-0.1.0.zip",
      );
      expect(artifacts).toEqual([archive]);
      const python = resolve(".venv/bin/python");
      const names = JSON.parse(
        execFileSync(
          python,
          [
            "-I",
            "-c",
            "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
            archive,
          ],
          { encoding: "utf8" },
        ),
      ) as string[];
      expect(names).toContain("Sage.app/.hidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("ASAR entries use one portable spelling for admission checks", async () => {
  const { canonicalArchiveEntry } = await import("../../scripts/check_package");
  expect(canonicalArchiveEntry("\\.vite\\build\\main.cjs", "win32")).toBe(
    "/.vite/build/main.cjs",
  );
  expect(canonicalArchiveEntry("/.vite/build/main.cjs", "darwin")).toBe(
    "/.vite/build/main.cjs",
  );
  expect(canonicalArchiveEntry("/.vite\\build/main.cjs", "darwin")).toBe(
    "/.vite\\build/main.cjs",
  );
});

test("crafted ASAR header cannot alias an allowlisted file or traverse", async () => {
  const { validateRawArchiveHeader } =
    await import("../../scripts/check_package");
  const header = {
    files: {
      ".vite": {
        files: { build: { files: { "main.cjs": { offset: "0", size: 0 } } } },
      },
    },
  };
  expect(() => validateRawArchiveHeader(header)).not.toThrow();
  for (const hidden of [
    ".vite\\build\\main.cjs",
    ".vite/build/main.cjs",
    "..",
    ".",
  ]) {
    const crafted = structuredClone(header) as {
      files: Record<string, unknown>;
    };
    crafted.files[hidden] = { offset: "0", size: 0, private: "__sageE2E" };
    expect(() => validateRawArchiveHeader(crafted)).toThrow(
      "Unsafe application archive",
    );
  }
});

test("actual ASAR inspection rejects private test composition and credential patterns", async () => {
  const { validateArchive } = await import("../../scripts/check_package");
  const root = await mkdtemp(join(tmpdir(), "sage-asar-negative-"));
  const archive = root + ".asar";
  try {
    await productionLayout(root);
    await createPackage(root, archive);
    expect(() => validateArchive(archive)).not.toThrow();
    for (const content of ["__sageE2E", "gho_" + "SYNTHETIC".repeat(5)]) {
      await writeFile(join(root, ".vite/build/main.cjs"), content);
      await createPackage(root, archive);
      expect(() => validateArchive(archive)).toThrow(
        "Unsafe application archive",
      );
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(archive, { force: true }),
    ]);
  }
});

test.each([
  ".vite/prompts/private.txt",
  ".vite/extra.node",
  ".vite-private/credentials.txt",
])("actual ASAR admission rejects %s", async (name) => {
  const { validateArchive } = await import("../../scripts/check_package");
  const root = await mkdtemp(join(tmpdir(), "sage-asar-admission-"));
  const archive = root + ".asar";
  try {
    await productionLayout(root);
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), "Harmless synthetic payload");
    await createPackage(root, archive);
    expect(() => validateArchive(archive)).toThrow(
      "Unsafe application archive",
    );
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(archive, { force: true }),
    ]);
  }
});

test("actual ASAR accepts the supported production bundle and static asset layout", async () => {
  const { validateArchive } = await import("../../scripts/check_package");
  const root = await mkdtemp(join(tmpdir(), "sage-asar-production-"));
  const archive = root + ".asar";
  try {
    await productionLayout(root);
    await createPackage(root, archive);
    expect(() => validateArchive(archive)).not.toThrow();
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(archive, { force: true }),
    ]);
  }
});

// Identity fixtures keep ASAR and fixed Python inventory real; fuses and ZIP are separate boundaries.
vi.mock("@electron/fuses", async (original) => ({
  ...(await original<object>()),
  getCurrentFuseWire: async () => ({
    0: 48,
    1: 49,
    2: 48,
    3: 48,
    4: 49,
    5: 49,
  }),
}));
vi.mock("../../scripts/check_extension.mjs", () => ({
  validateVsix: async () => ({
    entries: [],
    sha256: fixtureDigest,
    bundleSha256: "b".repeat(64),
  }),
}));
const fixtureBytes = Buffer.from("owned synthetic VSIX");
const fixtureDigest = (await import("node:crypto"))
  .createHash("sha256")
  .update(fixtureBytes)
  .digest("hex");
async function identityPackage(root: string) {
  const app = join(
    root,
    process.platform === "darwin" ? "Sage.app" : "Sage-win32-x64",
  );
  const resources = join(
    app,
    process.platform === "darwin" ? "Contents/Resources" : "resources",
  );
  const source = join(root, "source");
  const manifest = join(root, "resource-manifest.json");
  const descriptor = {
    schema: 1,
    platform: process.platform === "darwin" ? "darwin-arm64" : "win32-x64",
    bytes: fixtureBytes.length,
    sha256: fixtureDigest,
  };
  const marker =
    "SAGE_EDITOR_EXTENSION_V1:" +
    Buffer.from(JSON.stringify(descriptor)).toString("base64");
  await productionLayout(source);
  await writeFile(
    join(source, ".vite/build/main.cjs"),
    `exports.editorExtensionMarker = "${marker}";`,
  );
  await mkdir(join(resources, "core"), { recursive: true });
  const core = join(
    resources,
    "core",
    process.platform === "win32" ? "sage-core.exe" : "sage-core",
  );
  await writeFile(core, "owned inert core", { mode: 0o755 });
  await mkdir(join(resources, "editor-extension"));
  await writeFile(
    join(resources, "editor-extension/sage-editor-bridge.vsix"),
    fixtureBytes,
  );
  execFileSync(
    resolve(
      process.platform === "win32"
        ? ".venv/Scripts/python.exe"
        : ".venv/bin/python",
    ),
    [
      "scripts/package_manifest.py",
      resources,
      "--manifest",
      manifest,
      "--record",
    ],
    { stdio: "pipe" },
  );
  await writeFile(
    join(root, "editor-extension.json"),
    JSON.stringify(descriptor),
  );
  await createPackage(source, join(resources, "app.asar"));
  return { app, manifest, resources, source, descriptor, marker };
}
test("loaded package baseline passes and missing extension descriptor is refused", async () => {
  const { validatePackage } = await import("../../scripts/check_package");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-identity-package-")),
  );
  try {
    const fixture = await identityPackage(root);
    await expect(
      validatePackage(fixture.app, fixture.manifest),
    ).resolves.toMatchObject({
      sha256: fixtureDigest,
      bytes: fixtureBytes.length,
    });
    await rm(join(root, "editor-extension.json"));
    await expect(
      validatePackage(fixture.app, fixture.manifest),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function rejectPackageDrift(failure: string) {
  const { validatePackage } = await import("../../scripts/check_package");
  const { readFile, symlink, rename } = await import("node:fs/promises");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-package-drift-")),
  );
  try {
    const fixture = await identityPackage(root);
    await expect(
      validatePackage(fixture.app, fixture.manifest),
    ).resolves.toMatchObject({ sha256: fixtureDigest });
    if (failure.startsWith("main-")) {
      const value =
        failure === "main-missing"
          ? "exports.empty = true;"
          : failure === "main-null"
            ? 'exports.marker="SAGE_EDITOR_EXTENSION_V1:bnVsbA==";'
            : `exports.marker="${fixture.marker}"; exports.other="${fixture.marker}";`;
      await writeFile(join(fixture.source, ".vite/build/main.cjs"), value);
      await createPackage(fixture.source, join(fixture.resources, "app.asar"));
    } else if (failure === "descriptor-drift")
      await writeFile(
        join(root, "editor-extension.json"),
        JSON.stringify({ ...fixture.descriptor, sha256: "a".repeat(64) }),
      );
    else if (failure === "resource-drift")
      await writeFile(
        join(fixture.resources, "editor-extension/sage-editor-bridge.vsix"),
        "modified",
      );
    else if (failure.startsWith("manifest-")) {
      const data = JSON.parse(await readFile(fixture.manifest, "utf8"));
      if (failure === "manifest-escape")
        data.entries["../escape"] = Object.values(data.entries)[0];
      else data.schema = true;
      await writeFile(fixture.manifest, JSON.stringify(data));
    } else if (failure === "linked-app") {
      const link = join(root, "Linked.app");
      await symlink(fixture.app, link, "dir");
      await expect(validatePackage(link, fixture.manifest)).rejects.toThrow();
      return;
    } else if (failure === "linked-manifest") {
      const link = join(root, "linked.json");
      await symlink(fixture.manifest, link);
      await expect(validatePackage(fixture.app, link)).rejects.toThrow();
      return;
    } else {
      const moved = join(root, "moved-resources");
      await rename(fixture.resources, moved);
      await symlink(moved, fixture.resources, "dir");
    }
    await expect(
      validatePackage(fixture.app, fixture.manifest),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test.each([
  "main-missing",
  "main-duplicate",
  "main-null",
  "descriptor-drift",
  "resource-drift",
  "manifest-escape",
  "manifest-type",
])(
  "package identity refuses %s from a loaded valid baseline",
  rejectPackageDrift,
);
test
  .skipIf(process.platform === "win32")
  .each(["linked-app", "linked-manifest", "linked-resources"])(
  "package identity refuses %s from a loaded valid baseline",
  rejectPackageDrift,
);

test("direct Node TS CLI rejects every incomplete or extra selector with fixed diagnostics", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const args of [
    [],
    ["--vsix"],
    ["--vsix", "private-archive", "extra"],
    ["private-app"],
    ["private-app", "private-manifest", "extra"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/check_package.ts", ...args],
      { cwd: resolve("."), encoding: "utf8", timeout: 10000, shell: false },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("FAIL package checks\n");
  }
});
