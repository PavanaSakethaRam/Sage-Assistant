export interface VsixInputs {
  platform: "darwin-arm64" | "win32-x64";
  files: Record<string, Uint8Array>;
}
export interface CheckedVsix {
  entries: string[];
  sha256: string;
  bundleSha256: string;
}
export function validateVsix(
  archive: string,
  expected?: VsixInputs,
): Promise<CheckedVsix>;
export function extractVsix(
  archive: string,
  destination: string,
  expected?: VsixInputs,
): Promise<CheckedVsix>;
