import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPackage } from "@electron/asar";
import { MakerZIP } from "@electron-forge/maker-zip";
import { expect, test } from "vitest";
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
          { encoding: "utf8" },
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
        { encoding: "utf8" },
      );
      expect(replaced.trim()).toBe("replacement");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
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
