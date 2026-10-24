/** Rejects descriptor, embedded marker and fixed resource identity drift. */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import {
  boundedFile,
  compiledExtensionIdentity,
  extensionMarker,
  extensionPlatform,
  MAX_DESCRIPTOR_BYTES,
  MAX_EXTENSION_BYTES,
  ordinaryPath,
  parseExtensionDescriptor,
  parseExtensionMarker,
  readExtensionIdentity,
} from "../main/extension-export";
const bytes = Buffer.from("owned extension");
const identity = {
  schema: 1 as const,
  platform: extensionPlatform(),
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const encode = (data: unknown) => Buffer.from(JSON.stringify(data));
const roots: string[] = [];
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "sage-extension-identity-")),
  );
  roots.push(root);
  const descriptor = join(root, "editor-extension.json");
  const archive = join(root, "editor-extension/sage-editor-bridge.vsix");
  mkdirSync(join(root, "editor-extension"));
  writeFileSync(descriptor, encode(identity));
  writeFileSync(archive, bytes);
  return { root, descriptor, archive };
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});
test("closed descriptor has bounded UTF8 and canonical identity", () => {
  expect(parseExtensionDescriptor(encode(identity))).toEqual(identity);
  for (const data of [
    null,
    [],
    {},
    { ...identity, extra: 1 },
    { ...identity, schema: true },
    { ...identity, schema: 2 },
    { ...identity, platform: "linux-x64" },
    { ...identity, bytes: true },
    { ...identity, bytes: 0 },
    { ...identity, bytes: 1.5 },
    { ...identity, bytes: MAX_EXTENSION_BYTES + 1 },
    { ...identity, sha256: "A".repeat(64) },
    { ...identity, sha256: 1 },
  ])
    expect(() => parseExtensionDescriptor(encode(data))).toThrow();
  for (const raw of [
    Buffer.alloc(0),
    Buffer.alloc(MAX_DESCRIPTOR_BYTES + 1),
    Buffer.from([0xff]),
    Buffer.from("\ufeff" + JSON.stringify(identity)),
    Buffer.from("{"),
  ])
    expect(() => parseExtensionDescriptor(raw)).toThrow();
  const missing = { ...identity } as Partial<typeof identity>;
  delete missing.sha256;
  expect(() => parseExtensionDescriptor(encode(missing))).toThrow();
  expect(
    parseExtensionDescriptor(
      encode({ ...identity, bytes: MAX_EXTENSION_BYTES }),
    ).bytes,
  ).toBe(MAX_EXTENSION_BYTES);
});
test("canonical markers accept source null but packaged main requires exactly one identity", () => {
  const marker = extensionMarker(identity);
  expect(parseExtensionMarker(marker)).toEqual(identity);
  expect(parseExtensionMarker(extensionMarker(null))).toBeNull();
  expect(
    compiledExtensionIdentity(
      `const prefix="SAGE_EDITOR_EXTENSION_V1:"; exports.marker="${marker}";`,
    ),
  ).toEqual(identity);
  const noncanonical =
    "SAGE_EDITOR_EXTENSION_V1:" +
    Buffer.from(JSON.stringify({ ...identity }, null, 2)).toString("base64");
  for (const invalid of [
    "wrong",
    "SAGE_EDITOR_EXTENSION_V1:",
    marker.slice(0, -1),
    marker + "=",
    "SAGE_EDITOR_EXTENSION_V1:bnVsbB==",
    "SAGE_EDITOR_EXTENSION_V1:" + "A".repeat(1372),
    noncanonical,
  ])
    expect(() => parseExtensionMarker(invalid)).toThrow();
  for (const source of [
    "exports.none=1;",
    `"${marker}";"${marker}"`,
    '"SAGE_EDITOR_EXTENSION_V1:%%%"',
    `"${extensionMarker(null)}"`,
    `"${marker}$"`,
  ])
    expect(() => compiledExtensionIdentity(source)).toThrow();
});
test("fixed ordinary resource and descriptor must agree, with absent source pair allowed", () => {
  const { root, descriptor, archive } = fixture();
  expect(readExtensionIdentity(descriptor, root)).toEqual(identity);
  writeFileSync(archive, "modified");
  expect(() => readExtensionIdentity(descriptor, root)).toThrow();
  writeFileSync(archive, Buffer.alloc(MAX_EXTENSION_BYTES + 1));
  expect(() => readExtensionIdentity(descriptor, root)).toThrow();
  writeFileSync(archive, Buffer.alloc(0));
  expect(() => boundedFile(archive, MAX_EXTENSION_BYTES)).toThrow();
  rmSync(archive);
  expect(() => readExtensionIdentity(descriptor, root, true)).toThrow();
  rmSync(descriptor);
  expect(readExtensionIdentity(descriptor, root, true)).toBeNull();
  writeFileSync(archive, bytes);
  expect(() => readExtensionIdentity(descriptor, root, true)).toThrow();
  expect(() => ordinaryPath("relative", false)).toThrow();
  expect(() => ordinaryPath(root, false)).toThrow();
  expect(() => ordinaryPath(archive, true)).toThrow();
});
test.skipIf(process.platform === "win32")(
  "linked and nonordinary inputs are refused",
  () => {
    const { root, descriptor, archive } = fixture();
    rmSync(archive);
    symlinkSync(descriptor, archive);
    expect(() => readExtensionIdentity(descriptor, root)).toThrow();
    rmSync(archive);
    mkdirSync(archive);
    expect(() => readExtensionIdentity(descriptor, root)).toThrow();
    rmSync(archive, { recursive: true });
    writeFileSync(archive, bytes);
    const linked = join(root, "linked");
    symlinkSync(root, linked);
    expect(() => readExtensionIdentity(descriptor, linked)).toThrow();
    rmSync(descriptor);
    symlinkSync(archive, descriptor);
    expect(() => readExtensionIdentity(descriptor, root)).toThrow();
  },
);
test("loaded Vite config always defines a full marker and rejects partial or drifted stage", async () => {
  const { root } = fixture();
  const original = process.cwd();
  mkdirSync(join(root, "build"));
  mkdirSync(join(root, ".runtime/package"), { recursive: true });
  try {
    process.chdir(root);
    const load = async () => {
      vi.resetModules();
      const { default: config } = await import("../../vite.main.config");
      return JSON.parse(config.define!.SAGE_EDITOR_EXTENSION_MARKER as string);
    };
    expect(await load()).toBe(extensionMarker(null));
    writeFileSync(join(root, "build/editor-extension.json"), encode(identity));
    await expect(load()).rejects.toThrow();
    mkdirSync(join(root, ".runtime/package/editor-extension"));
    writeFileSync(
      join(root, ".runtime/package/editor-extension/sage-editor-bridge.vsix"),
      bytes,
    );
    expect(await load()).toBe(extensionMarker(identity));
    writeFileSync(join(root, "build/editor-extension.json"), "{}");
    await expect(load()).rejects.toThrow();
    writeFileSync(join(root, "build/editor-extension.json"), encode(identity));
    writeFileSync(
      join(root, ".runtime/package/editor-extension/sage-editor-bridge.vsix"),
      "drift",
    );
    await expect(load()).rejects.toThrow();
  } finally {
    process.chdir(original);
  }
});

test("compiled scan refuses an additional malformed escaped marker", () => {
  const source = `exports.marker="${extensionMarker(identity)}"; exports.bad="SAGE_EDITOR_EXTENSION_V1:\\invalid";`;
  expect(() => compiledExtensionIdentity(source)).toThrow();
});
