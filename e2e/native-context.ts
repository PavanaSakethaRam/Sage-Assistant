export function assertNativeElectronContext(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (platform === "darwin" && env.CODEX_SANDBOX === "seatbelt") {
    throw new Error(
      "Native Electron tests require approved GUI-capable execution outside the command sandbox.",
    );
  }
}
