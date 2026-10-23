import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPackage } from "@electron/asar";
import { expect, test } from "vitest";

test("actual ASAR inspection rejects private test composition and credential patterns", async () => {
  const { validateArchive } = await import("../../scripts/check_package");
  const root = await mkdtemp(join(tmpdir(), "sage-asar-negative-"));
  const archive = root + ".asar";
  try {
    await mkdir(join(root, ".vite/build"), { recursive: true });
    await writeFile(join(root, "package.json"), '{"name":"synthetic"}');
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
