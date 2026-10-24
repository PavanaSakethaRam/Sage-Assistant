/** Deterministic owned-profile launcher. Never download, discover a real editor or weaken trust. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { chromium } from "@playwright/test";
import { assertNativeElectronContext } from "../e2e/native-context.ts";
import { validateVsix } from "./check_package.ts";
import { rootProbeName } from "./build-root-probe.ts";
import { revalidate, VERSION } from "./provision-vscode.ts";
import { fileURLToPath } from "node:url";
const activeChildren = new Set<ChildProcess>();
const SUITE_LIMIT = 600_000,
  CASE_LIMIT = 120_000,
  OUTPUT_LIMIT = 262144;
const REPLACE_SCENARIOS: readonly import("../extension/test/integration/replace").ReplaceScenario[] =
  [
    "success",
    "participant",
    "human-save",
    "cancel-save",
    "disconnect-save",
    "expiry-save",
    "external-save",
    "auto-save",
  ];
export function selectedCase(
  args: string[],
): "bridge" | "context" | "create" | "replace" | "all" {
  if (args.length === 0) return "bridge";
  if (args.length === 4) {
    if (
      args[0] !== "--case" ||
      args[1] !== "replace" ||
      args[2] !== "--scenario" ||
      !REPLACE_SCENARIOS.includes(
        args[3] as import("../extension/test/integration/replace").ReplaceScenario,
      )
    )
      throw Error("Unknown editor test scenario");
    return "replace";
  }
  if (
    args.length !== 2 ||
    args[0] !== "--case" ||
    ![
      "bridge",
      "context",
      "create",
      "replace",
      "test-runner",
      "recovery",
      "all",
    ].includes(args[1])
  )
    throw Error("Unknown editor test case");
  if (
    args[1] !== "bridge" &&
    args[1] !== "context" &&
    args[1] !== "create" &&
    args[1] !== "replace" &&
    args[1] !== "all"
  )
    throw Error("Editor case is not implemented in Task4");
  return args[1];
}
async function until<T>(
  read: () => Promise<T | undefined>,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Owned editor receipt deadline");
}
async function json(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 5_000);
    const deadline = setTimeout(() => {
      clearTimeout(timer);
      done();
    }, 10_000);
    child.once("close", () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      done();
    });
    child.kill();
  });
  if (child.exitCode === null && child.signalCode === null)
    throw Error("Owned editor shutdown unconfirmed");
}
function guiEnv(
  home: string,
  temp: string,
  fixture: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "local"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PATH: "",
    SAGE_OWNED_FIXTURE: fixture,
    LANG: "en_US.UTF-8",
  };
  if (process.platform === "win32")
    for (const key of ["SystemRoot", "WINDIR", "ComSpec"])
      if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function seedTrust(
  shared: string,
  uri: string,
  trusted: boolean,
): Promise<void> {
  const database = join(shared, "sharedStorage/state.vscdb");
  await mkdir(join(shared, "sharedStorage"), { recursive: true });
  const python = resolve(
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
  );
  const seed =
    "import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=1'); c.execute('CREATE TABLE ItemTable(key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)'); c.execute('INSERT INTO ItemTable VALUES (?,?)',('content.trust.model.key',sys.argv[2])); c.commit(); c.close()";
  const trust = JSON.stringify({
    uriTrustInfo: trusted
      ? [
          {
            uri: { scheme: "file", authority: "", path: new URL(uri).pathname },
            trusted: true,
          },
        ]
      : [],
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, ["-c", seed, database, trust], {
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(Error("Owned trust fixture setup failed")),
    );
  });
}
async function lane(
  executable: string,
  trusted: boolean,
  packaged = false,
  selectedCase: "bridge" | "context" | "create" | "replace" | "all" = "bridge",
  createScenario: import("../extension/test/integration/create").CreateScenario = "success",
  replaceScenario: import("../extension/test/integration/replace").ReplaceScenario = "success",
): Promise<void> {
  const owned = await realpath(
    await mkdtemp(
      join(
        process.platform === "darwin" ? "/private/tmp" : tmpdir(),
        "sage-vscode-owned-",
      ),
    ),
  );
  const profile = join(owned, "profile"),
    shared = join(owned, "shared"),
    extensions = join(owned, "extensions"),
    home = join(owned, "home"),
    temp = join(owned, "temp"),
    workspace = join(
      owned,
      process.platform === "darwin" && selectedCase !== "bridge"
        ? "workspace:context"
        : "workspace",
    ),
    fixture = join(owned, "fixture");
  for (const path of [
    profile,
    shared,
    extensions,
    home,
    temp,
    workspace,
    fixture,
  ])
    await mkdir(path, { recursive: true });
  const { pathToFileURL } = await import("node:url");
  const uri = pathToFileURL(workspace).href;
  await mkdir(join(profile, "User"), { recursive: true });
  await writeFile(
    join(profile, "User/settings.json"),
    JSON.stringify({
      "security.workspace.trust.enabled": true,
      "window.dialogStyle": "custom",
      "chat.disableAIFeatures": true,
      "security.workspace.trust.startupPrompt": "never",
      "git.enabled": false,
      "git.autofetch": false,
      "github.gitAuthentication": false,
      "github.gitProtocol": "https",
      "update.mode": "none",
      "extensions.autoCheckUpdates": false,
      "extensions.autoUpdate": false,
      "telemetry.telemetryLevel": "off",
      "workbench.startupEditor": "none",
      "workbench.welcomePage.walkthroughs.openOnInstall": false,
      "workbench.enableExperiments": false,
      "extensions.ignoreRecommendations": true,
      "window.restoreWindows": "none",
      "files.autoSave":
        selectedCase === "replace" && replaceScenario === "auto-save"
          ? "afterDelay"
          : "off",
    }),
  );
  await seedTrust(shared, uri, trusted);
  let packageHash: string | undefined,
    bundleHash: string | undefined,
    productPath: string | undefined;
  if (packaged) {
    const vsix = resolve(".cache/sage-editor-bridge.vsix");
    await validateVsix(vsix);
    const bytes = await readFile(vsix);
    packageHash = createHash("sha256").update(bytes).digest("hex");
    bundleHash = createHash("sha256")
      .update(await readFile(resolve("extension/dist/extension.cjs")))
      .digest("hex");
    productPath = join(extensions, "sage-local.sage-editor-bridge-0.1.0");
    await mkdir(productPath);
    const python = resolve(
      ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    );
    const extract = `import sys,zipfile,io,stat,pathlib
root=pathlib.Path(sys.argv[1])
allowed={'extension/package.json','extension/dist/extension.cjs','extension/readme.md','extension/LICENSE.txt','extension/THIRD_PARTY_NOTICES.md','extension/dist/${rootProbeName()}','extension.vsixmanifest','[Content_Types].xml'}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
 items=z.infolist(); assert len(items)==8 and {i.filename for i in items}==allowed
 for i in items:
  assert not stat.S_ISLNK(i.external_attr>>16) and i.file_size<=1048576 and not i.flag_bits&1
  if not i.filename.startswith('extension/'): continue
  target=root/i.filename[len('extension/'):]; target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('xb') as f: f.write(z.read(i))
  if i.filename=='extension/dist/${rootProbeName()}': target.chmod(0o755)`;
    const extracted = spawnSync(python, ["-c", extract, productPath], {
      shell: false,
      input: bytes,
      timeout: 30_000,
      maxBuffer: 262144,
    });
    if (extracted.status !== 0) throw Error("Owned package extraction failed");
    if (
      createHash("sha256")
        .update(await readFile(join(productPath, "dist/extension.cjs")))
        .digest("hex") !== bundleHash
    )
      throw Error("Owned package bundle drift");
  }
  const nonce = randomBytes(16).toString("hex"),
    label = packaged
      ? trusted
        ? "packaged-trusted"
        : "packaged-restricted"
      : "trusted";
  const config = {
    nonce,
    trusted,
    lane: label,
    phase: "initial",
    packaged,
    packageHash,
    bundleHash,
    productPath,
    selectedCase,
    createScenario,
    replaceScenario,
    fixtureSource: resolve("tests/fixtures/focus-project"),
    expectedRoot: uri,
  };
  await writeFile(join(fixture, "case.json"), JSON.stringify(config));
  const argv = [
    "--user-data-dir",
    profile,
    "--shared-data-dir",
    shared,
    "--extensions-dir",
    extensions,
    "--new-window",
    "--skip-welcome",
    "--use-inmemory-secretstorage",
    ...(packaged ? [] : ["--extensionDevelopmentPath", resolve("extension")]),
    "--extensionDevelopmentPath",
    resolve("extension/test/driver"),
    "--remote-debugging-port=0",
    workspace,
  ];
  // Existing native preflight runs before every launch, after all safe fixture preparation.
  assertNativeElectronContext();
  const child = spawn(executable, argv, {
    shell: false,
    detached: false,
    env: guiEnv(home, temp, fixture),
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  let bytes = 0;
  let failed: Error | undefined;
  let output = "";
  child.on("error", () => {
    failed = Error("Owned editor spawn failed");
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_LIMIT) {
        failed = Error("Owned editor output overflow");
        void stop(child);
      } else output += chunk.toString();
    });
  const timer = setTimeout(() => {
    failed = Error("Owned editor case timeout");
    void stop(child);
  }, CASE_LIMIT);
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let host:
    | {
        close(): Promise<void>;
        assertDisconnected(): Promise<void>;
        exerciseContext(): Promise<void>;
      }
    | undefined;
  try {
    const receipt = async (phase: string) =>
      until(async () => {
        if (failed) throw failed;
        const failure = await json(join(fixture, "failure.json"));
        if (failure)
          throw Error(
            "Owned extension driver failed: " + JSON.stringify(failure),
          );
        const result = await json(join(fixture, `complete-${phase}.json`));
        if (
          result &&
          (result.nonce !== nonce ||
            result.lane !== label ||
            result.phase !== phase ||
            result.trusted !== trusted ||
            result.trust_enabled !== true ||
            result.vscode !== VERSION ||
            !Number.isSafeInteger(result.pid) ||
            result.ppid !== child.pid)
        )
          throw Error("Uncorrelated editor receipt");
        return result;
      }, CASE_LIMIT);
    const attach = async () => {
      const active = await until(async () => {
        try {
          return await readFile(join(profile, "DevToolsActivePort"), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        }
      });
      const [port, endpoint] = active.trim().split("\n");
      if (
        !/^\d+$/u.test(port) ||
        Number(port) < 1 ||
        Number(port) > 65535 ||
        !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(endpoint) ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        !child.pid
      )
        throw Error("Invalid owned debug endpoint");
      browser = await chromium.connectOverCDP(
        `ws://127.0.0.1:${port}${endpoint}`,
      );
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw Error("Owned editor workbench missing");
      return page;
    };
    if (trusted) {
      const ready = await until(() => json(join(fixture, "ready.json")));
      if (
        ready.nonce !== nonce ||
        ready.ppid !== child.pid ||
        ready.trusted !== true ||
        ready.status !== "ready"
      )
        throw Error("Uncorrelated editor ready receipt");
      const page = await attach();
      const integration = await import(
        pathToFileURL(resolve(".cache/vscode-tools/bridge.cjs")).href
      );
      host =
        selectedCase === "replace"
          ? await integration.replaceThroughWorkbench(
              page,
              fixture,
              workspace,
              replaceScenario,
            )
          : selectedCase === "create"
            ? await integration.createThroughWorkbench(
                page,
                fixture,
                workspace,
                createScenario,
              )
            : await integration.pairThroughWorkbench(
                page,
                selectedCase !== "bridge",
              );
      if (
        selectedCase !== "bridge" &&
        selectedCase !== "create" &&
        selectedCase !== "replace"
      )
        await host!.exerciseContext();
      console.log(
        JSON.stringify({
          profile: owned,
          receipt: await receipt("initial"),
          ...(selectedCase === "replace"
            ? {
                replace_authority: await json(
                  join(fixture, "replace-authority.json"),
                ),
                replace_races: await json(join(fixture, "replace-races.json")),
              }
            : selectedCase === "create"
              ? {
                  create_authority: await json(
                    join(fixture, "create-authority.json"),
                  ),
                  diffs: await json(join(fixture, "diffs-checked.json")),
                }
              : selectedCase !== "bridge"
                ? {
                    context_native: await json(
                      join(fixture, "context-native.json"),
                    ),
                  }
                : {}),
        }),
      );
      if (
        !packaged &&
        (selectedCase !== "replace" || replaceScenario === "success")
      ) {
        await writeFile(
          join(fixture, "case.json"),
          JSON.stringify({ ...config, phase: "reload" }),
        );
        await page.keyboard.press(
          process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P",
        );
        const command = page.getByPlaceholder(
          "Type the name of a command to run.",
          { exact: true },
        );
        await command.fill(">Developer: Reload Window");
        await command.press("Enter");
        console.log(
          JSON.stringify({ profile: owned, receipt: await receipt("reload") }),
        );
        // Reload must tear down the old pair; no retry or source path is involved.
        await host!.assertDisconnected();
      }
    } else {
      const completed = await receipt("initial");
      if (completed.product_active !== false)
        throw Error("Restricted product activated");
      const page = await attach();
      if (
        await page
          .getByPlaceholder("Sage pairing ticket", { exact: true })
          .count()
      )
        throw Error("Restricted product opened pairing input");
      console.log(
        JSON.stringify({
          profile: owned,
          receipt: { ...completed, pairing_input_count: 0 },
        }),
      );
    }
    if (failed) throw failed;
  } catch (error) {
    console.error(
      JSON.stringify({
        profile: owned,
        lane: label,
        diagnostics: output.slice(0, OUTPUT_LIMIT),
      }),
    );
    throw error;
  } finally {
    clearTimeout(timer);
    await host?.close();
    await browser?.close();
    await stop(child);
    activeChildren.delete(child);
    if (selectedCase !== "create" && selectedCase !== "replace")
      await rm(owned, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2),
    selected = selectedCase(args),
    requestedScenario =
      args.length === 4
        ? (args[3] as import("../extension/test/integration/replace").ReplaceScenario)
        : undefined;
  assertNativeElectronContext();
  const suiteTimer = setTimeout(() => {
    console.error("FAIL editor suite timeout");
    const hardStop = setTimeout(() => process.exit(1), 10_000);
    void Promise.allSettled([...activeChildren].map(stop)).then(() => {
      clearTimeout(hardStop);
      process.exit(1);
    });
  }, SUITE_LIMIT);
  try {
    const executable = await revalidate();
    await build({
      configFile: false,
      define: {
        __SAGE_ROOT_PROBE_SHA256__: JSON.stringify(
          createHash("sha256")
            .update(await readFile(join("extension/dist", rootProbeName())))
            .digest("hex"),
        ),
      },
      logLevel: "silent",
      build: {
        outDir: "extension/test/driver/dist",
        emptyOutDir: true,
        sourcemap: false,
        lib: {
          entry: "extension/test/driver/extension.ts",
          formats: ["cjs"],
          fileName: () => "driver.cjs",
        },
        rolldownOptions: { external: ["vscode", /^node:/] },
      },
    });
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: ".cache/vscode-tools",
        emptyOutDir: true,
        sourcemap: false,
        lib: {
          entry: "extension/test/integration/bridge.ts",
          formats: ["cjs"],
          fileName: () => "bridge.cjs",
        },
        rolldownOptions: { external: ["vscode", "@playwright/test", /^node:/] },
      },
    });
    try {
      if (requestedScenario)
        await lane(
          executable,
          true,
          false,
          "replace",
          "success",
          requestedScenario,
        );
      else {
        await lane(executable, true, false, selected);
        if (selected !== "replace") {
          await lane(await revalidate(), true, true, selected);
          await lane(await revalidate(), false, true, selected);
        }
        if (selected === "replace")
          for (const scenario of [
            "participant",
            "human-save",
            "cancel-save",
            "disconnect-save",
            "expiry-save",
            "external-save",
            "auto-save",
          ] as const)
            await lane(
              await revalidate(),
              true,
              false,
              "replace",
              "success",
              scenario,
            );
        if (selected === "create")
          for (const scenario of [
            "decline",
            "collision",
            "root-switch",
            "cancel-prefix",
            "ack-loss",
            "expiry",
          ] as const)
            await lane(await revalidate(), true, false, "create", scenario);
      }
      console.log(
        selected === "replace"
          ? requestedScenario
            ? `PASS owned editor replacement scenario ${requestedScenario}`
            : "PASS owned editor replacement, byte observations, native version races and persisted trust reload"
          : "PASS owned editor bridge, persisted trust reload and actual Restricted Mode refusal",
      );
    } finally {
      clearTimeout(suiteTimer);
    }
  } finally {
    clearTimeout(suiteTimer);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(
      "FAIL editor host checks:",
      error instanceof Error ? error.message : "unknown failure",
    );
    process.exitCode = 1;
  });
