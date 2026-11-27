import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { WindowsSafeMakerZIP } from "./scripts/windows-zip-maker";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseVersion, FuseV1Options } from "@electron/fuses";
export async function copyStagedResources(
  staging: string,
  resources: string,
): Promise<void> {
  await Promise.all(
    ["core", "copilot", "gh", "notices", "editor-extension"].map((name) =>
      cp(join(staging, name), join(resources, name), {
        recursive: true,
        verbatimSymlinks: true,
      }),
    ),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    download: { cacheRoot: resolve(".cache/electron") },
    // Copy beside app.asar before signing. Packager's default resource copy
    // turns relative symlinks into absolute paths back to the build checkout.
    afterAsar: [
      ({ buildPath }) =>
        copyStagedResources(resolve(".runtime/package"), dirname(buildPath)),
    ],
  },
  makers: [new WindowsSafeMakerZIP({}, ["darwin", "win32"])],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "desktop/main/index.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "desktop/preload/index.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
export default config;
