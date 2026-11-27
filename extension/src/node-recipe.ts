/** The standalone Node build measured for the fixed test recipe. */
const PIN = "06eb3f5762c2b6890e99d03f931bf01d9b20fd341dec1a8c1ef5c1809e66102b";

export function isMeasuredNodeRecipe(version: string, sha256: string): boolean {
  return (
    process.platform === "darwin" &&
    process.arch === "arm64" &&
    version === "26.12.1" &&
    sha256 === PIN
  );
}
