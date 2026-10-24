import { afterEach, expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  mkdir,
  readdir,
  stat,
  symlink,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  validateVsix,
  extractVsix,
  type VsixInputs,
} from "../../scripts/check_extension.mjs";

const roots: string[] = [];
const childBoundary = vi.hoisted(() => ({
  beforeSpawn: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", async (original) => {
  const real = await original<typeof import("node:child_process")>();
  return {
    ...real,
    spawnSync: (...args: Parameters<typeof real.spawnSync>) => {
      const before = childBoundary.beforeSpawn;
      childBoundary.beforeSpawn = undefined;
      before?.();
      return real.spawnSync(...args);
    },
  };
});
afterEach(async () => {
  childBoundary.beforeSpawn = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const manifest = {
  name: "sage-editor-bridge",
  displayName: "Sage Local Editor Bridge",
  description: "Explicit local pairing with the Sage desktop host",
  version: "0.1.0",
  publisher: "sage-local",
  license: "UNLICENSED",
  engines: { vscode: "^1.143.0" },
  extensionKind: ["ui"],
  main: "./dist/extension.cjs",
  activationEvents: [
    "onCommand:sage.pairLocalEditor",
    "onCommand:sage.inspectInterruptedJournal",
    "onCommand:sage.inspectInterruptedJob",
  ],
  capabilities: {
    untrustedWorkspaces: { supported: false },
    virtualWorkspaces: { supported: false },
  },
  contributes: {
    commands: [
      { command: "sage.pairLocalEditor", title: "Sage: Pair Local Editor" },
      {
        command: "sage.captureContext",
        title: "Sage: Capture Explicit Context",
      },
      { command: "sage.sendContext", title: "Sage: Send Selected Context" },
      { command: "sage.cancelContext", title: "Sage: Cancel Context" },
      {
        command: "sage.inspectInterruptedJournal",
        title: "Sage: Inspect Interrupted Sage Journal",
      },
      {
        command: "sage.inspectInterruptedJob",
        title: "Sage: Inspect Interrupted Job",
      },
      { command: "sage.dismissInspection", title: "Sage: Dismiss Inspection" },
    ],
  },
  repository: {
    type: "git",
    url: "https://github.com/PavanaSakethaRam/Sage-Assistant.git",
    directory: "extension",
  },
};
const XML = `<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata>
<Identity Language="en-US" Id="sage-editor-bridge" Version="0.1.0" Publisher="sage-local"/>
<DisplayName>Sage Local Editor Bridge</DisplayName><Description xml:space="preserve">Explicit local pairing with the Sage desktop host</Description>
<Tags/><Categories/><GalleryFlags>Public</GalleryFlags><Properties>
<Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.143.0"/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
<Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/><Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
<Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true"/>
<Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/PavanaSakethaRam/Sage-Assistant.git"/>
<Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/PavanaSakethaRam/Sage-Assistant.git"/>
<Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/PavanaSakethaRam/Sage-Assistant.git"/>
<Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/PavanaSakethaRam/Sage-Assistant/issues"/>
<Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://github.com/PavanaSakethaRam/Sage-Assistant#readme"/>
<Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true"/><Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>
</Properties><License>extension/LICENSE.txt</License></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/></Assets></PackageManifest>`;
const TYPES = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".cjs" ContentType="application/octet-stream"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".txt" ContentType="text/plain"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>`;

test("native Node ESM imports the CLI checker and validates an independent archive", async () => {
  const fixture = await archive();
  const checker = pathToFileURL(resolve("scripts/check_extension.mjs")).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {readFileSync} from 'node:fs';
    const {validateVsix}=await import(${JSON.stringify(checker)});
    const input=JSON.parse(readFileSync(0,'utf8'));
    input.expected.files=Object.fromEntries(Object.entries(input.expected.files).map(([key,value])=>[key,Buffer.from(value,'base64')]));
    const result=await validateVsix(input.path,input.expected);
    console.log(JSON.stringify({entries:result.entries.length}));
  `,
    ],
    {
      input: JSON.stringify({
        path: fixture.path,
        expected: {
          platform: fixture.expected.platform,
          files: Object.fromEntries(
            Object.entries(fixture.expected.files).map(([key, value]) => [
              key,
              Buffer.from(value).toString("base64"),
            ]),
          ),
        },
      }),
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 262144,
    },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ entries: 8 });
});

type Mutation = {
  mode?: number;
  creator?: number;
  name?: string;
  data?: string;
  duplicate?: boolean;
  encrypted?: boolean;
  archiveComment?: boolean;
  memberComment?: boolean;
  memberExtra?: boolean;
  localExtra?: boolean;
  prefix?: boolean;
  trailing?: boolean;
  declaredComment?: boolean;
  encoding?: "utf16le" | "invalid";
  helperName?: string;
  missing?: boolean;
  extra?: boolean;
  production?: boolean;
  platform?: VsixInputs["platform"];
  expected?: boolean;
  streaming?: boolean;
  unsignedDescriptor?: boolean;
  stored?: boolean;
  internalGap?: "central" | "member";
  compressedTail?: boolean;
  descriptorMismatch?: boolean;
  eocdCount?: boolean;
  localSizeMismatch?: boolean;
  descriptorTruncated?: boolean;
  centralDisk?: boolean;
  recordOverlap?: boolean;
};
async function archive(mutation: Mutation = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-extension-policy-")),
  );
  roots.push(root);
  const path = join(root, "fixture.vsix");
  const platform = mutation.platform ?? "darwin-arm64";
  const helper =
    mutation.helperName ??
    `extension/dist/root-probe-${platform}${platform === "win32-x64" ? ".exe" : ""}`;
  const files: Record<string, Uint8Array> = {
    "extension/package.json": Buffer.from(JSON.stringify(manifest)),
    [helper]: Buffer.from("synthetic-native-helper-not-executed"),
    "extension/readme.md": Buffer.from("Synthetic readme"),
    "extension/LICENSE.txt": Buffer.from("Synthetic license"),
    "extension/THIRD_PARTY_NOTICES.md": Buffer.from("Synthetic notices"),
  };
  files["extension/dist/extension.cjs"] = Buffer.from(
    `const vscode=require("vscode"); const fs=require("node:fs"); module.exports={vscode,fs,hash:"${hash(files[helper])}"};`,
  );
  if (mutation.production) {
    for (const name of Object.keys(files)) {
      const local =
        name === "extension/readme.md"
          ? "extension/README.md"
          : name === "extension/LICENSE.txt"
            ? "extension/LICENSE"
            : name;
      files[name] = await readFile(resolve(local));
    }
  }
  const entries: Record<string, string> = Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [
      name,
      Buffer.from(bytes).toString("base64"),
    ]),
  );
  entries["extension.vsixmanifest"] = Buffer.from(XML).toString("base64");
  entries["[Content_Types].xml"] = Buffer.from(TYPES).toString("base64");
  const name = mutation.name ?? helper;
  if (mutation.data !== undefined) {
    entries[name] = Buffer.from(mutation.data).toString("base64");
    if (mutation.expected && name in files)
      files[name] = Buffer.from(mutation.data);
  }
  if (mutation.encoding)
    entries["extension.vsixmanifest"] = (
      mutation.encoding === "utf16le"
        ? Buffer.from(XML, "utf16le")
        : Buffer.from([0xff, 0xfe, 0xfd])
    ).toString("base64");
  const python = resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const result = spawnSync(
    python,
    [
      "-c",
      `import sys,json,zipfile,base64,struct,io
+entries,mutation,helper=json.loads(sys.stdin.buffer.read())
+class Stream(io.BytesIO):
+ def seek(self,*args): raise io.UnsupportedOperation('owned streaming fixture')
+sink=Stream() if mutation.get('streaming') else sys.argv[1]
+with zipfile.ZipFile(sink,'w',compression=zipfile.ZIP_DEFLATED) as z:
+ if mutation.get('archiveComment'): z.comment=b'PRIVATE_MARKER'
+ for name,data in entries.items():
+  if mutation.get('missing') and name==helper: continue
+  item=zipfile.ZipInfo(name); item.create_system=3; item.external_attr=(0o100755 if name==helper else 0o100664)<<16
+  if name==helper:
+   item.external_attr=mutation.get('mode',0o100755)<<16; item.create_system=mutation.get('creator',3)
+   if mutation.get('memberComment'): item.comment=b'PRIVATE_MARKER'
+   if mutation.get('memberExtra'): item.extra=b'\\xfe\\xca\\x04\\x00test'
+  item.compress_type=zipfile.ZIP_STORED if mutation.get('stored') else zipfile.ZIP_DEFLATED; z.writestr(item,base64.b64decode(data))
+  if mutation.get('duplicate') and name==helper: z.writestr(item,base64.b64decode(data))
+ if mutation.get('extra'):
+  item=zipfile.ZipInfo('extension/test/driver.cjs'); item.create_system=3; item.external_attr=0o100644<<16; z.writestr(item,b'private driver')
+if mutation.get('streaming'): open(sys.argv[1],'wb').write(sink.getvalue())
+if mutation.get('unsignedDescriptor'):
+ raw=open(sys.argv[1],'rb').read(); end=len(raw)-22; central=struct.unpack_from('<I',raw,end+16)[0]; out=bytearray(); offsets={}
+ with zipfile.ZipFile(io.BytesIO(raw)) as original:
+  for item in sorted(original.infolist(),key=lambda item:item.header_offset):
+   start=item.header_offset; length=struct.unpack_from('<H',raw,start+26)[0]; stop=start+30+length+item.compress_size
+   assert raw[stop:stop+4]==b'PK\\x07\\x08'
+   offsets[start]=len(out); out+=raw[start:stop]+raw[stop+4:stop+16]
+ new_central=len(out); records=bytearray(raw[central:end]); at=0
+ while at<len(records):
+  length=46+sum(struct.unpack_from('<3H',records,at+28)); old=struct.unpack_from('<I',records,at+42)[0]; struct.pack_into('<I',records,at+42,offsets[old]); at+=length
+ trailer=bytearray(raw[end:]); struct.pack_into('<I',trailer,16,new_central); open(sys.argv[1],'wb').write(out+records+trailer)
+if mutation.get('internalGap') or mutation.get('compressedTail'):
+ raw=bytearray(open(sys.argv[1],'rb').read()); end=len(raw)-22; central=struct.unpack_from('<I',raw,end+16)[0]
+ with zipfile.ZipFile(io.BytesIO(raw)) as original: first,second=sorted(original.infolist(),key=lambda item:item.header_offset)[:2]
+ point=central if mutation.get('internalGap')=='central' else second.header_offset
+ if mutation.get('compressedTail'):
+  point=first.header_offset+30+len(first.filename.encode())+first.compress_size
+ gap=b'PRIVATE_SOURCE_PAYLOAD\\n-----BEGIN OPENSSH PRIVATE KEY-----\\nPRIVATE_MARKER\\n'
+ raw[point:point]=gap; central+=len(gap); end+=len(gap); struct.pack_into('<I',raw,end+16,central)
+ at=central
+ while at<end:
+  offset=struct.unpack_from('<I',raw,at+42)[0]
+  if offset>=point: struct.pack_into('<I',raw,at+42,offset+len(gap))
+  if mutation.get('compressedTail') and offset==first.header_offset: struct.pack_into('<I',raw,at+20,first.compress_size+len(gap))
+  at+=46+sum(struct.unpack_from('<3H',raw,at+28))
+ if mutation.get('compressedTail'):
+  if first.flag_bits&8: struct.pack_into('<I',raw,point+len(gap)+8,first.compress_size+len(gap))
+  else: struct.pack_into('<I',raw,first.header_offset+18,first.compress_size+len(gap))
+ open(sys.argv[1],'wb').write(raw)
+ with zipfile.ZipFile(sys.argv[1]) as check:
+  assert check.testzip() is None and len(check.infolist())==8
+  assert all(check.read(name)==base64.b64decode(data) for name,data in entries.items())
+if mutation.get('descriptorMismatch') or mutation.get('eocdCount') or mutation.get('localSizeMismatch'):
+ raw=bytearray(open(sys.argv[1],'rb').read())
+ if mutation.get('descriptorMismatch'):
+  at=raw.find(b'PK\\x07\\x08'); assert at>=0; raw[at+4]^=1
+ if mutation.get('eocdCount'): struct.pack_into('<H',raw,len(raw)-12,7)
+ if mutation.get('localSizeMismatch'): struct.pack_into('<I',raw,22,1)
+ open(sys.argv[1],'wb').write(raw)
+if mutation.get('descriptorTruncated') or mutation.get('centralDisk') or mutation.get('recordOverlap'):
+ raw=bytearray(open(sys.argv[1],'rb').read()); end=len(raw)-22; central=struct.unpack_from('<I',raw,end+16)[0]
+ if mutation.get('centralDisk'): struct.pack_into('<H',raw,central+34,1)
+ if mutation.get('recordOverlap'):
+  with zipfile.ZipFile(io.BytesIO(raw)) as original: first=original.infolist()[0]
+  struct.pack_into('<I',raw,18,first.compress_size+1); struct.pack_into('<I',raw,central+20,first.compress_size+1)
+ if mutation.get('descriptorTruncated'):
+  at=raw.find(b'PK\\x07\\x08'); assert at>=0; del raw[at+12:at+16]; central-=4; end-=4; struct.pack_into('<I',raw,end+16,central)
+  cursor=central
+  while cursor<end:
+   offset=struct.unpack_from('<I',raw,cursor+42)[0]
+   if offset>at: struct.pack_into('<I',raw,cursor+42,offset-4)
+   cursor+=46+sum(struct.unpack_from('<3H',raw,cursor+28))
+ open(sys.argv[1],'wb').write(raw)
+ if mutation.get('descriptorTruncated'):
+  with zipfile.ZipFile(sys.argv[1]) as check:
+   assert check.testzip() is None and all(check.read(name)==base64.b64decode(data) for name,data in entries.items())
+if mutation.get('encrypted'):
+ raw=bytearray(open(sys.argv[1],'rb').read())
+ for signature,offset in [(b'PK\\x03\\x04',6),(b'PK\\x01\\x02',8)]:
+  at=raw.find(signature); struct.pack_into('<H',raw,at+offset,struct.unpack_from('<H',raw,at+offset)[0]|1)
+ open(sys.argv[1],'wb').write(raw)
+if mutation.get('localExtra'):
+ raw=bytearray(open(sys.argv[1],'rb').read()); length=struct.unpack_from('<H',raw,26)[0]; point=30+length
+ raw[point:point]=b'\\xfe\\xca\\x04\\x00test'; struct.pack_into('<H',raw,28,8)
+ at=raw.find(b'PK\\x01\\x02')
+ while at>=0:
+  offset=struct.unpack_from('<I',raw,at+42)[0]
+  if offset: struct.pack_into('<I',raw,at+42,offset+8)
+  at=raw.find(b'PK\\x01\\x02',at+4)
+ end=raw.rfind(b'PK\\x05\\x06'); struct.pack_into('<I',raw,end+16,struct.unpack_from('<I',raw,end+16)[0]+8)
+ open(sys.argv[1],'wb').write(raw)
+ with zipfile.ZipFile(sys.argv[1]) as check:
+  assert check.testzip() is None
+  assert all(check.read(name)==base64.b64decode(data) for name,data in entries.items())
+if mutation.get('prefix') or mutation.get('trailing'):
+ raw=open(sys.argv[1],'rb').read()
+ open(sys.argv[1],'wb').write((b'PRIVATE_MARKER' if mutation.get('prefix') else b'')+raw+(b'PRIVATE_MARKER' if mutation.get('trailing') else b''))
+if mutation.get('declaredComment'):
+ raw=bytearray(open(sys.argv[1],'rb').read()); struct.pack_into('<H',raw,len(raw)-2,1); open(sys.argv[1],'wb').write(raw)
+`.replace(/^\+/gm, ""),
      path,
    ],
    {
      input: JSON.stringify([entries, mutation, helper]),
      shell: false,
      timeout: 30_000,
      maxBuffer: 262144,
    },
  );
  expect(result.status).toBe(0);
  return {
    path,
    root,
    helper,
    expected: { platform, files } satisfies VsixInputs,
  };
}

test.each(["darwin-arm64", "win32-x64"] as const)(
  "accepts independent fixed payloads and ordinary 0664 metadata: %s",
  async (platform) => {
    const fixture = await archive({ platform });
    const result = await validateVsix(fixture.path, fixture.expected);
    expect(result.entries).toEqual([
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/LICENSE.txt",
      "extension/THIRD_PARTY_NOTICES.md",
      "extension/dist/extension.cjs",
      fixture.helper,
      "extension/package.json",
      "extension/readme.md",
    ]);
    expect(result.sha256).toBe(hash(await readFile(fixture.path)));
    expect(result.bundleSha256).toBe(
      hash(fixture.expected.files["extension/dist/extension.cjs"]),
    );
  },
);

test("refuses an inherited platform key that would otherwise select an unapproved helper name", async () => {
  const fixture = await archive({
    platform: "__proto__" as VsixInputs["platform"],
    helperName: "extension/dist/[object Object]",
  });
  await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX platform",
  );
});

test.each([
  { stored: true },
  { streaming: true },
  { streaming: true, unsignedDescriptor: true },
])(
  "accepts complete known ZIP records including optional streaming descriptors: %j",
  async (mutation) => {
    const fixture = await archive(mutation);
    await expect(
      validateVsix(fixture.path, fixture.expected),
    ).resolves.toMatchObject({
      entries: expect.arrayContaining([fixture.helper]),
    });
  },
);

test.each([
  { internalGap: "central" as const },
  { internalGap: "member" as const },
  { compressedTail: true },
  { compressedTail: true, streaming: true },
  { descriptorMismatch: true, streaming: true },
  { eocdCount: true },
  { localSizeMismatch: true },
  { descriptorTruncated: true, streaming: true },
  { centralDisk: true },
  { recordOverlap: true },
])(
  "refuses unaccounted archive bytes or mismatched record boundaries: %j",
  async (mutation) => {
    const fixture = await archive(mutation);
    const destination = join(fixture.root, "extension");
    await expect(
      extractVsix(fixture.path, destination, fixture.expected),
    ).rejects.toThrow("Unsafe VSIX metadata");
    expect(await readdir(fixture.root)).toEqual(["fixture.vsix"]);
  },
);

test.each([
  ["missing execute", 0o100644, 3],
  ["unknown creator", 0o100755, 0],
  ["symlink", 0o120755, 3],
  ["directory", 0o040755, 3],
  ["fifo", 0o010755, 3],
  ["device", 0o020755, 3],
  ["setuid", 0o104755, 3],
  ["setgid", 0o102755, 3],
  ["sticky", 0o101755, 3],
] as const)(
  "refuses a bytes-preserving helper metadata mutation: %s",
  async (_name, mode, creator) => {
    const fixture = await archive({ mode, creator });
    await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
      "Unsafe VSIX metadata",
    );
  },
);

test.each([{ extra: true }, { duplicate: true }, { missing: true }])(
  "rejects fixed-inventory violation %j",
  async (mutation) => {
    const fixture = await archive(mutation);
    await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
      "Unsafe VSIX inventory",
    );
  },
);

test.each([
  [
    "manifest wrong publisher",
    "extension/package.json",
    JSON.stringify({ ...manifest, publisher: "other" }),
    "manifest",
  ],
  [
    "manifest dependency",
    "extension/package.json",
    JSON.stringify({ ...manifest, dependencies: { unsafe: "1" } }),
    "manifest",
  ],
  [
    "manifest command drift",
    "extension/package.json",
    JSON.stringify({ ...manifest, contributes: { commands: [] } }),
    "manifest",
  ],
  [
    "manifest boolean type drift",
    "extension/package.json",
    JSON.stringify({
      ...manifest,
      capabilities: {
        untrustedWorkspaces: { supported: 0 },
        virtualWorkspaces: { supported: false },
      },
    }),
    "manifest",
  ],
  [
    "manifest duplicate key",
    "extension/package.json",
    JSON.stringify(manifest).replace(
      '"publisher":"sage-local"',
      '"publisher":"sage-local","publisher":"other"',
    ),
    "manifest",
  ],
  [
    "XML DTD",
    "extension.vsixmanifest",
    '<!DOCTYPE PackageManifest [<!ENTITY marker "PRIVATE_MARKER">]>' + XML,
    "xml",
  ],
  [
    "XML foreign identity",
    "extension.vsixmanifest",
    XML.replace('Publisher="sage-local"', 'Publisher="other"'),
    "xml",
  ],
  [
    "XML unexpected text",
    "extension.vsixmanifest",
    XML.replace("<Metadata>", "<Metadata>PRIVATE_MARKER"),
    "xml",
  ],
  [
    "XML undeclared asset",
    "extension.vsixmanifest",
    XML.replace("extension/package.json", "extension/test/private.ts"),
    "xml",
  ],
  [
    "XML dependency",
    "extension.vsixmanifest",
    XML.replace(
      "<Dependencies/>",
      '<Dependencies><Dependency Id="unsafe"/></Dependencies>',
    ),
    "xml",
  ],
  [
    "XML content type",
    "[Content_Types].xml",
    TYPES.replace("application/json", "text/html"),
    "xml",
  ],
  ["malformed XML", "extension.vsixmanifest", "<broken>", "parser"],
] as const)(
  "independently rejects %s even with matching declared payload bytes",
  async (_label, name, data, kind) => {
    const fixture = await archive({ name, data, expected: true });
    await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
      `Unsafe VSIX ${kind}`,
    );
  },
);

test.each([
  ["external dependency", 'require("unsafe-package");'],
  ["relative dependency", 'require("./private.cjs");'],
  ["nonliteral require", "require(somewhere);"],
  ["aliased require", 'const other=require; other("unsafe");'],
  ["dynamic import", 'import("node:fs");'],
  ["computed require", 'globalThis["require"]("unsafe");'],
  ["parse error", "const = ;"],
  ["sourcemap", "//# sourceMappingURL=private.map"],
  ["TypeScript-only grammar", "const typed: number = 1;"],
  ["driver leak", 'const marker="__sageE2E";'],
] as const)(
  "rejects CJS %s despite fixture content hash agreement",
  async (_label, suffix) => {
    const initial = await archive();
    const data =
      Buffer.from(
        initial.expected.files["extension/dist/extension.cjs"],
      ).toString() + suffix;
    const fixture = await archive({
      name: "extension/dist/extension.cjs",
      data,
      expected: true,
    });
    await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
      "Unsafe VSIX runtime",
    );
  },
);

test("checks payload hashes and does not accept fixture XML or arbitrary inventory inputs", async () => {
  const fixture = await archive({
    name: "extension/readme.md",
    data: "tampered",
  });
  await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX content",
  );
  fixture.expected.files["extension.vsixmanifest"] = Buffer.from(XML);
  await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX inputs",
  );
});

test.each(["utf16le", "invalid"] as const)(
  "rejects XML bytes outside strict UTF-8: %s",
  async (encoding) => {
    const fixture = await archive({ encoding });
    await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
      "Unsafe VSIX",
    );
  },
);

test("rejects encrypted, oversize entry, oversize archive, malformed archive and archive symlink", async () => {
  const encrypted = await archive({ encrypted: true });
  await expect(
    validateVsix(encrypted.path, encrypted.expected),
  ).rejects.toThrow("Unsafe VSIX metadata");
  const huge = await archive({
    name: "extension.vsixmanifest",
    data: "x".repeat(1048577),
  });
  await expect(validateVsix(huge.path, huge.expected)).rejects.toThrow(
    "Unsafe VSIX metadata",
  );
  const fixture = await archive();
  const link = join(fixture.root, "link.vsix");
  await symlink(fixture.path, link);
  await expect(validateVsix(link, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX archive",
  );
  await writeFile(fixture.path, Buffer.alloc(2097153));
  await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX archive",
  );
  await writeFile(fixture.path, "malformed");
  await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX parser",
  );
});

test("extracts checked fixture bytes and validated POSIX modes without a consumer repair", async () => {
  const fixture = await archive({});
  const destination = join(fixture.root, "extension");
  const checked = await extractVsix(
    fixture.path,
    destination,
    fixture.expected,
  );
  expect(checked.sha256).toBe(hash(await readFile(fixture.path)));
  for (const [name, bytes] of Object.entries(fixture.expected.files)) {
    const extracted = join(destination, name.slice("extension/".length));
    expect(await readFile(extracted)).toEqual(Buffer.from(bytes));
    if (process.platform !== "win32")
      expect((await stat(extracted)).mode & 0o7777).toBe(
        name === fixture.helper ? 0o755 : 0o664,
      );
  }
  expect((await readdir(destination)).sort()).toEqual([
    "LICENSE.txt",
    "THIRD_PARTY_NOTICES.md",
    "dist",
    "package.json",
    "readme.md",
  ]);
});

test("invalid metadata fails before any extraction destination is written", async () => {
  const fixture = await archive({ mode: 0o100644 });
  const destination = join(fixture.root, "extension");
  await expect(
    extractVsix(fixture.path, destination, fixture.expected),
  ).rejects.toThrow("Unsafe VSIX metadata");
  expect(await readdir(fixture.root)).toEqual(["fixture.vsix"]);
});

test("refuses nonempty or linked extraction destinations and preserves existing bytes", async () => {
  const fixture = await archive({});
  const destination = join(fixture.root, "extension");
  await mkdir(destination);
  await writeFile(join(destination, "sentinel"), "untouched");
  await expect(
    extractVsix(fixture.path, destination, fixture.expected),
  ).rejects.toThrow("Unsafe VSIX destination");
  expect(await readFile(join(destination, "sentinel"), "utf8")).toBe(
    "untouched",
  );
  const linked = join(fixture.root, "linked");
  await symlink(destination, linked, "dir");
  await expect(
    extractVsix(fixture.path, linked, fixture.expected),
  ).rejects.toThrow("Unsafe VSIX destination");
});

test("extracts the validated byte snapshot even if the archive pathname changes at child dispatch", async () => {
  const fixture = await archive();
  const originalHash = hash(await readFile(fixture.path));
  childBoundary.beforeSpawn = () =>
    writeFileSync(fixture.path, "PRIVATE_MARKER replaced archive");
  const destination = join(fixture.root, "extension");
  const checked = await extractVsix(
    fixture.path,
    destination,
    fixture.expected,
  );
  expect(checked.sha256).toBe(originalHash);
  expect(await readFile(fixture.path, "utf8")).toBe(
    "PRIVATE_MARKER replaced archive",
  );
  expect(await readFile(join(destination, "dist/extension.cjs"))).toEqual(
    Buffer.from(fixture.expected.files["extension/dist/extension.cjs"]),
  );
});

test("rejects relative destinations and independently invalid manifest before creating a directory", async () => {
  const fixture = await archive();
  await expect(
    extractVsix(fixture.path, "relative", fixture.expected),
  ).rejects.toThrow("Unsafe VSIX destination");
  const invalid = await archive({
    name: "extension/package.json",
    data: JSON.stringify({ ...manifest, main: "./test/driver.cjs" }),
    expected: true,
  });
  await expect(
    extractVsix(
      invalid.path,
      join(invalid.root, "extension"),
      invalid.expected,
    ),
  ).rejects.toThrow("Unsafe VSIX manifest");
  expect(await readdir(invalid.root)).toEqual(["fixture.vsix"]);
});

test("refuses unsupported or malformed fixture inputs without leaking marker values", async () => {
  const fixture = await archive();
  for (const inputs of [
    { ...fixture.expected, platform: "PRIVATE_MARKER" },
    { ...fixture.expected, unexpected: "PRIVATE_MARKER" },
    {
      ...fixture.expected,
      files: {
        ...fixture.expected.files,
        [fixture.helper]: Buffer.alloc(1048577),
      },
    },
  ]) {
    await expect(
      validateVsix(fixture.path, inputs as VsixInputs),
    ).rejects.toThrow(/^Unsafe VSIX (?:platform|inputs)$/);
  }
});

test.each([
  { archiveComment: true },
  { memberComment: true },
  { memberExtra: true },
  { localExtra: true },
  { prefix: true },
  { trailing: true },
  { declaredComment: true },
])("refuses unreviewed ZIP metadata %j", async (mutation) => {
  const fixture = await archive(mutation);
  await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
    "Unsafe VSIX metadata",
  );
});

test.each([
  [
    "extension/readme.md",
    ["gh", "p_"].join("") + "A1b2C3d4E5".repeat(4),
    "content",
  ],
  [
    "extension/THIRD_PARTY_NOTICES.md",
    "//# sourceMappingURL=private.map",
    "content",
  ],
  ["extension/LICENSE.txt", "__sageE2E", "content"],
  ["extension.vsixmanifest", "<!--PRIVATE_MARKER-->" + XML, "xml"],
  ["extension.vsixmanifest", "<?private PRIVATE_MARKER?>" + XML, "xml"],
  ["extension.vsixmanifest", XML + "\u0000", "content"],
] as const)(
  "refuses independently declared artifact leakage/encoding in %s",
  async (name, data, kind) => {
    const fixture = await archive({ name, data, expected: true });
    await expect(validateVsix(fixture.path, fixture.expected)).rejects.toThrow(
      `Unsafe VSIX ${kind}`,
    );
  },
);
