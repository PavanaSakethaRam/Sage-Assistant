import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPackage } from "@electron/asar";
import { MakerZIP } from "@electron-forge/maker-zip";
import { expect, test } from "vitest";

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
});

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
