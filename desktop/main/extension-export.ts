/** Fixed packaged extension identity; no destination or application side effects. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const MAX_EXTENSION_BYTES = 2_097_152;
export const MAX_DESCRIPTOR_BYTES = 1_024;
const PREFIX = "SAGE_EDITOR_EXTENSION_V1:";
export type ExtensionPlatform = "darwin-arm64" | "win32-x64";
export interface ExtensionIdentity {
  schema: 1;
  platform: ExtensionPlatform;
  bytes: number;
  sha256: string;
}
export function extensionPlatform(): ExtensionPlatform {
  if (process.platform === "darwin" && process.arch === "arm64")
    return "darwin-arm64";
  if (process.platform === "win32" && process.arch === "x64")
    return "win32-x64";
  throw Error("Unsupported extension platform");
}
export function ordinaryPath(path: string, directory: boolean): void {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    realpathSync.native(path) !== path
  )
    throw Error("Unsafe extension path");
  let current = path;
  for (;;) {
    const info = lstatSync(current);
    if (
      info.isSymbolicLink() ||
      (current === path && !directory ? !info.isFile() : !info.isDirectory())
    )
      throw Error("Unsafe extension path");
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}
export function boundedFile(path: string, maximum: number): Buffer {
  ordinaryPath(path, false);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > maximum)
      throw Error("Invalid extension size");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
      if (!count || length === bytes.length) break;
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (
      length !== before.size ||
      length > maximum ||
      current.isSymbolicLink() ||
      [after, current].some(
        (info) =>
          info.dev !== before.dev ||
          info.ino !== before.ino ||
          info.size !== before.size ||
          info.mtimeMs !== before.mtimeMs ||
          info.ctimeMs !== before.ctimeMs,
      )
    )
      throw Error("Extension changed during read");
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}
export function parseExtensionDescriptor(
  bytes: Uint8Array,
  platform = extensionPlatform(),
): ExtensionIdentity {
  if (bytes.length < 1 || bytes.length > MAX_DESCRIPTOR_BYTES)
    throw Error("Invalid extension descriptor");
  const data: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    Object.keys(data).sort().join(",") !== "bytes,platform,schema,sha256"
  )
    throw Error("Invalid extension descriptor");
  const value = data as Record<string, unknown>;
  if (
    value.schema !== 1 ||
    value.platform !== platform ||
    typeof value.bytes !== "number" ||
    !Number.isInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_EXTENSION_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  )
    throw Error("Invalid extension descriptor");
  return { schema: 1, platform, bytes: value.bytes, sha256: value.sha256 };
}
export function extensionMarker(identity: ExtensionIdentity | null): string {
  const data =
    identity === null
      ? null
      : parseExtensionDescriptor(
          Buffer.from(JSON.stringify(identity)),
          identity.platform,
        );
  return PREFIX + Buffer.from(JSON.stringify(data)).toString("base64");
}
export function parseExtensionMarker(
  marker: string,
  platform = extensionPlatform(),
): ExtensionIdentity | null {
  if (!marker.startsWith(PREFIX)) throw Error("Invalid extension marker");
  const payload = marker.slice(PREFIX.length);
  if (
    !payload ||
    payload.length > 1_368 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      payload,
    )
  )
    throw Error("Invalid extension marker");
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload)
    throw Error("Invalid extension marker");
  const identity = bytes.equals(Buffer.from("null"))
    ? null
    : parseExtensionDescriptor(bytes, platform);
  if (extensionMarker(identity) !== marker)
    throw Error("Invalid extension marker");
  return identity;
}
export function compiledExtensionIdentity(
  source: string,
  platform = extensionPlatform(),
): ExtensionIdentity {
  const candidates = [
    ...source.matchAll(/SAGE_EDITOR_EXTENSION_V1:([^"'`\s;,){}\[\]]+)/gu),
  ];
  if (candidates.length !== 1)
    throw Error("Missing or duplicate extension marker");
  const identity = parseExtensionMarker(candidates[0][0], platform);
  if (identity === null) throw Error("Missing packaged extension identity");
  return identity;
}
export function readExtensionIdentity(
  descriptor: string,
  resources: string,
  allowAbsent = false,
): ExtensionIdentity | null {
  const archive = join(resources, "editor-extension/sage-editor-bridge.vsix");
  const missing = (path: string) => {
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  };
  if (allowAbsent && missing(descriptor) && missing(archive)) return null;
  const identity = parseExtensionDescriptor(
    boundedFile(descriptor, MAX_DESCRIPTOR_BYTES),
  );
  const bytes = boundedFile(archive, MAX_EXTENSION_BYTES);
  if (
    identity.bytes !== bytes.length ||
    identity.sha256 !== createHash("sha256").update(bytes).digest("hex")
  )
    throw Error("Extension identity mismatch");
  return identity;
}
