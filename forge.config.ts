import { resolve } from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { WindowsSafeMakerZIP } from "./scripts/windows-zip-maker";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseVersion, FuseV1Options } from "@electron/fuses";
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    download: { cacheRoot: resolve(".cache/electron") },
    extraResource: [
      ".runtime/package/core",
      ".runtime/package/copilot",
      ".runtime/package/gh",
      ".runtime/package/notices",
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
