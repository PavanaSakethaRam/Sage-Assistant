/** One bounded, host-specific VSIX policy for packaging and owned editor fixtures. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Module, { builtinModules } from "node:module";
import { Script } from "node:vm";
import ts from "typescript";

const MAX_ARCHIVE = 2097152;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const helpers = {
  "darwin-arm64": "root-probe-darwin-arm64",
  "win32-x64": "root-probe-win32-x64.exe",
};

async function readArchive(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.size < 1 || before.size > MAX_ARCHIVE)
    throw Error("Unsafe VSIX archive");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    )
      throw Error("Unsafe VSIX archive");
    const bytes = Buffer.alloc(MAX_ARCHIVE + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        bytes.length - length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (!length || length > MAX_ARCHIVE) throw Error("Unsafe VSIX archive");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function expectedInputs(inputs) {
  if (
    inputs !== undefined &&
    (!inputs ||
      typeof inputs !== "object" ||
      Object.keys(inputs).sort().join(",") !== "files,platform" ||
      !inputs.files ||
      typeof inputs.files !== "object")
  )
    throw Error("Unsafe VSIX inputs");
  const platform = inputs?.platform ?? `${process.platform}-${process.arch}`;
  if (typeof platform !== "string" || !Object.hasOwn(helpers, platform))
    throw Error("Unsafe VSIX platform");
  const helperName = helpers[platform];
  const helper = `extension/dist/${helperName}`;
  const sources = {
    "extension/package.json": "extension/package.json",
    "extension/dist/extension.cjs": "extension/dist/extension.cjs",
    "extension/readme.md": "extension/README.md",
    "extension/LICENSE.txt": "extension/LICENSE",
    "extension/THIRD_PARTY_NOTICES.md": "extension/THIRD_PARTY_NOTICES.md",
    [helper]: helper,
  };
  const files =
    inputs?.files ??
    Object.fromEntries(
      await Promise.all(
        Object.entries(sources).map(async ([name, path]) => [
          name,
          await readFile(resolve(path)),
        ]),
      ),
    );
  if (
    Object.keys(files).length !== 6 ||
    Object.keys(files).some((name) => !(name in sources))
  )
    throw Error("Unsafe VSIX inputs");
  const hashes = {};
  for (const name of Object.keys(sources)) {
    if (
      !(files[name] instanceof Uint8Array) ||
      !files[name].byteLength ||
      files[name].byteLength > 1048576
    )
      throw Error("Unsafe VSIX inputs");
    hashes[name] = sha256(files[name]);
  }
  validateRuntime(
    Buffer.from(files["extension/dist/extension.cjs"]).toString("utf8"),
  );
  return { helper, hashes };
}

function validateRuntime(text) {
  try {
    // Compile the CommonJS wrapper only; TypeScript's JS parser also admits typed syntax.
    new Script(Module.wrap(text));
  } catch {
    throw Error("Unsafe VSIX runtime");
  }
  const source = ts.createSourceFile(
    "extension.cjs",
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length) throw Error("Unsafe VSIX runtime");
  const allowed = new Set(
    builtinModules
      .filter((name) => !name.startsWith("_"))
      .map((name) => name.replace(/^node:/, "")),
  );
  let vscode = false;
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      throw Error("Unsafe VSIX runtime");
    if (ts.isIdentifier(node) && node.text === "require") {
      const call = node.parent;
      if (
        !ts.isCallExpression(call) ||
        call.expression !== node ||
        call.questionDotToken ||
        call.arguments.length !== 1 ||
        !ts.isStringLiteral(call.arguments[0])
      )
        throw Error("Unsafe VSIX runtime");
      const name = call.arguments[0].text;
      if (name === "vscode") vscode = true;
      else if (!name.startsWith("node:") || !allowed.has(name.slice(5)))
        throw Error("Unsafe VSIX runtime");
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === "require"
    )
      throw Error("Unsafe VSIX runtime");
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!vscode) throw Error("Unsafe VSIX runtime");
}

// XML is parsed only after rejecting DTD/entity constructs; ElementTree never resolves external input.
const CHECK = `import sys,json,zipfile,hashlib,stat,io,re,struct,xml.etree.ElementTree as ET
FORBIDDEN=r'sourceMappingURL|__sageE2E|FakeReasoner|e2e/fixtures|events\\.jsonl|full\\.once|egress_probe|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\\bgh[opusr]_[A-Za-z0-9]{20,}|\\bgithub_pat_[A-Za-z0-9_]{20,}'
def check(ok,kind):
 if not ok: raise ValueError(kind)
def parse_json(raw):
 def pairs(items):
  out={}
  for key,value in items:
   check(key not in out,'manifest'); out[key]=value
  return out
 return json.loads(raw.decode('utf-8'),object_pairs_hook=pairs)
def xml(raw):
 check(not re.search(br'<!\\s*(?:DOCTYPE|ENTITY)',raw,re.I),'xml')
 check(not re.search(br'<!--|<\\?(?!xml(?:\\s|\\?>))',raw),'xml')
 return ET.fromstring(raw.decode('utf-8'))
def xml_check(data,manifest):
 ns='http://schemas.microsoft.com/developer/vsx-schema/2011'
 q=lambda name:'{'+ns+'}'+name
 root=xml(data['extension.vsixmanifest'])
 check(root.tag==q('PackageManifest') and root.attrib=={'Version':'2.0.0'},'xml')
 check([x.tag for x in root]==[q(x) for x in ['Metadata','Installation','Dependencies','Assets']],'xml')
 metadata,installation,dependencies,assets=list(root)
 check(not metadata.attrib and [x.tag for x in metadata]==[q(x) for x in ['Identity','DisplayName','Description','Tags','Categories','GalleryFlags','Properties','License']],'xml')
 identity,display,description,tags,categories,flags,properties,license=list(metadata)
 for item in root.iter():
  check(item in [display,description,tags,categories,flags,license] or not (item.text or '').strip(),'xml')
  check(not (item.tail or '').strip(),'xml')
 check(identity.attrib=={'Language':'en-US','Id':'sage-editor-bridge','Version':'0.1.0','Publisher':'sage-local'} and not list(identity),'xml')
 for item,value in [(display,manifest['displayName']),(description,manifest['description']),(tags,''),(categories,''),(flags,'Public'),(license,'extension/LICENSE.txt')]:
  check((item.text or '')==value and not list(item),'xml')
 check(not display.attrib and description.attrib=={'{http://www.w3.org/XML/1998/namespace}space':'preserve'} and all(not x.attrib for x in [tags,categories,flags,license]),'xml')
 prefix='Microsoft.VisualStudio.'
 repo='https://github.com/PavanaSakethaRam/Sage-Assistant'
 expected={prefix+'Code.'+key:value for key,value in {'Engine':'^1.143.0','ExtensionDependencies':'','ExtensionPack':'','ExtensionKind':'ui','LocalizedLanguages':'','EnabledApiProposals':'','ExecutesCode':'true'}.items()}
 expected.update({prefix+'Services.Links.'+key:repo+value for key,value in {'Source':'.git','Getstarted':'.git','GitHub':'.git','Support':'/issues','Learn':'#readme'}.items()})
 expected.update({prefix+'Services.GitHubFlavoredMarkdown':'true',prefix+'Services.Content.Pricing':'Free'})
 found={}
 check(not properties.attrib,'xml')
 for item in properties:
  check(item.tag==q('Property') and set(item.attrib)=={'Id','Value'} and not list(item) and item.attrib['Id'] not in found,'xml')
  found[item.attrib['Id']]=item.attrib['Value']
 check(found==expected,'xml')
 check(not installation.attrib and len(installation)==1 and installation[0].tag==q('InstallationTarget') and installation[0].attrib=={'Id':'Microsoft.VisualStudio.Code'} and not list(installation[0]),'xml')
 check(not dependencies.attrib and not list(dependencies) and not (dependencies.text or '').strip(),'xml')
 expected_assets=[{'Type':prefix+'Code.Manifest','Path':'extension/package.json','Addressable':'true'},{'Type':prefix+'Services.Content.Details','Path':'extension/readme.md','Addressable':'true'},{'Type':prefix+'Services.Content.License','Path':'extension/LICENSE.txt','Addressable':'true'}]
 check(not assets.attrib and len(assets)==3 and [x.attrib for x in assets]==expected_assets and all(x.tag==q('Asset') and not list(x) for x in assets),'xml')
 types=xml(data['[Content_Types].xml']); cns='{http://schemas.openxmlformats.org/package/2006/content-types}'
 expected_types={'.cjs':'application/octet-stream','.json':'application/json','.md':'text/markdown','.txt':'text/plain','.vsixmanifest':'text/xml'}
 check(types.tag==cns+'Types' and not types.attrib and len(types)==5,'xml')
 check(all(not (item.text or '').strip() and not (item.tail or '').strip() for item in types.iter()),'xml')
 actual={}
 for item in types:
  check(item.tag==cns+'Default' and set(item.attrib)=={'Extension','ContentType'} and not list(item) and item.attrib['Extension'] not in actual,'xml')
  actual[item.attrib['Extension']]=item.attrib['ContentType']
 check(actual==expected_types,'xml')
try:
 expected,helper=json.loads(sys.argv[1]),sys.argv[2]
 raw=sys.stdin.buffer.read(2097153); check(0<len(raw)<=2097152,'archive')
 with zipfile.ZipFile(io.BytesIO(raw)) as z:
  items=z.infolist(); names=[i.filename for i in items]
  check(len(names)==len(set(names))==8 and set(names)==set(expected)|{'[Content_Types].xml','extension.vsixmanifest'},'inventory')
  check(not z.comment and raw[-2:]==bytes(2) and min(i.header_offset for i in items)==0 and raw[-22:-18]==b'PK\\x05\\x06','metadata')
  data={}
  for item in items:
   mode=item.external_attr>>16
   check(not item.extra and not item.comment and 0<=item.header_offset<=len(raw)-30,'metadata')
   header=struct.unpack_from('<4s5H3I2H',raw,item.header_offset)
   name_start=item.header_offset+30; name_end=name_start+header[9]
   check(header[0]==b'PK\\x03\\x04' and header[10]==0 and name_end<=len(raw) and raw[name_start:name_end]==item.filename.encode('ascii') and header[2]==item.flag_bits and header[3]==item.compress_type,'metadata')
   check(item.create_system==3 and stat.S_ISREG(mode) and not mode&0o7000 and not item.external_attr&0x10,'metadata')
   check(item.filename!=helper or mode==0o100755,'metadata')
   check(0<item.file_size<=1048576 and item.compress_type in {0,8} and not item.flag_bits&~0x808,'metadata')
   data[item.filename]=z.read(item)
   if item.filename in expected: check(hashlib.sha256(data[item.filename]).hexdigest()==expected[item.filename],'content')
   if item.filename!=helper:
    try: text=data[item.filename].decode('utf-8')
    except UnicodeDecodeError: raise ValueError('content')
    kind='runtime' if item.filename=='extension/dist/extension.cjs' else 'content'
    check(chr(0) not in text and not re.search(FORBIDDEN,text),kind)
  manifest=parse_json(data['extension/package.json'])
  commands=[('sage.pairLocalEditor','Sage: Pair Local Editor'),('sage.captureContext','Sage: Capture Explicit Context'),('sage.sendContext','Sage: Send Selected Context'),('sage.cancelContext','Sage: Cancel Context'),('sage.inspectInterruptedJournal','Sage: Inspect Interrupted Sage Journal'),('sage.inspectInterruptedJob','Sage: Inspect Interrupted Job'),('sage.dismissInspection','Sage: Dismiss Inspection')]
  wanted={'name':'sage-editor-bridge','displayName':'Sage Local Editor Bridge','description':'Explicit local pairing with the Sage desktop host','version':'0.1.0','publisher':'sage-local','license':'UNLICENSED','engines':{'vscode':'^1.143.0'},'extensionKind':['ui'],'main':'./dist/extension.cjs','activationEvents':['onCommand:sage.pairLocalEditor','onCommand:sage.inspectInterruptedJournal','onCommand:sage.inspectInterruptedJob'],'capabilities':{'untrustedWorkspaces':{'supported':False},'virtualWorkspaces':{'supported':False}},'contributes':{'commands':[{'command':key,'title':title} for key,title in commands]},'repository':{'type':'git','url':'https://github.com/PavanaSakethaRam/Sage-Assistant.git','directory':'extension'}}
  check(json.dumps(manifest,sort_keys=True)==json.dumps(wanted,sort_keys=True),'manifest')
  xml_check(data,manifest)
  bundle=data['extension/dist/extension.cjs'].decode('utf-8')
  check(expected[helper] in bundle,'runtime')
  if len(sys.argv)==4:
   import pathlib,os
   root=pathlib.Path(sys.argv[3])
   check(root.is_absolute() and str(root.resolve())==str(root),'destination')
   if not root.exists(): root.mkdir()
   check(not root.is_symlink() and root.is_dir() and not any(root.iterdir()),'destination')
   check(os.name=='nt' or root.stat().st_uid==os.getuid(),'destination')
   for name in sorted(names):
    if not name.startswith('extension/'): continue
    target=root/name[len('extension/'):]; target.parent.mkdir(parents=True,exist_ok=True)
    with target.open('xb') as output: output.write(data[name])
    if os.name!='nt':
     mode=z.getinfo(name).external_attr>>16
     target.chmod(stat.S_IMODE(mode))
     check(stat.S_IMODE(target.stat().st_mode)==stat.S_IMODE(mode),'extraction')
  print(json.dumps({'entries':sorted(names),'sha256':hashlib.sha256(raw).hexdigest(),'bundleSha256':expected['extension/dist/extension.cjs']}))
except Exception as error:
 kind=str(error) if isinstance(error,ValueError) and str(error) in {'archive','inventory','metadata','content','manifest','xml','runtime','destination','extraction'} else 'parser'
 print(json.dumps({'failure':kind})); sys.exit(1)
`;

async function inspect(archive, inputs, destination) {
  try {
    const { helper, hashes } = await expectedInputs(inputs);
    const bytes = await readArchive(archive);
    const python = resolve(
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const args = ["-c", CHECK, JSON.stringify(hashes), helper];
    if (destination !== undefined) args.push(destination);
    const result = spawnSync(python, args, {
      shell: false,
      input: bytes,
      encoding: "utf8",
      maxBuffer: 262144,
      timeout: 30_000,
    });
    const checked = JSON.parse(result.stdout ?? "null");
    if (result.status !== 0 || !Array.isArray(checked?.entries))
      throw Error(
        `Unsafe VSIX ${["archive", "inventory", "metadata", "content", "manifest", "xml", "runtime", "destination", "extraction"].includes(checked?.failure) ? checked.failure : "parser"}`,
      );
    return checked;
  } catch (error) {
    if (error instanceof Error && /^Unsafe VSIX [a-z]+$/.test(error.message))
      throw error;
    throw Error("Unsafe VSIX parser");
  }
}

export async function validateVsix(archive, inputs) {
  return inspect(archive, inputs);
}

export async function extractVsix(archive, destination, inputs) {
  return inspect(archive, inputs, destination);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3) throw Error("Unsafe VSIX arguments");
    console.log(
      JSON.stringify({
        status: "pass",
        ...(await validateVsix(resolve(process.argv[2]))),
      }),
    );
  } catch {
    console.error("FAIL extension checks");
    process.exitCode = 1;
  }
}
