import { expect, it } from "vitest";
import { parseRequest } from "../shared/contracts";
it("accepts only closed explicit account actions and rejects renderer controls", () => {
  for (const method of ["copilot.chooseAccount", "copilot.disconnect"]) {
    expect(
      parseRequest({ version: 1, kind: "request", id: "a", method, params: {} })
        .method,
    ).toBe(method);
    expect(() =>
      parseRequest({
        version: 1,
        kind: "request",
        id: "a",
        method,
        params: { login: "other" },
      }),
    ).toThrow();
  }
  expect(() =>
    parseRequest({
      version: 1,
      kind: "host_copilot_selection",
      id: "a",
      boot_id: "a".repeat(32),
      generation: 1,
      account: null,
    }),
  ).toThrow();
});

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  symlink,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import {
  AccountBroker,
  defaultGhConfig,
  parseSelection,
  parseSelectionAck,
  EXECUTABLE_HASHES,
  EXECUTABLE_SIZES,
} from "../main/copilot-account";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("uses OS defaults without inherited custom GH/XDG configuration", () => {
  expect(defaultGhConfig("darwin", "/profile", "/app-data")).toBe(
    "/profile/.config/gh",
  );
  expect(defaultGhConfig("win32", "/profile", "/app-data")).toBe(
    "/app-data/GitHub CLI",
  );
});
it("closes the private selection and acknowledgement schemas", () => {
  const frame = {
    version: 1,
    kind: "host_copilot_selection",
    id: "pick",
    boot_id: "a".repeat(32),
    generation: 1,
    account: { host: "github.com", login: "synthetic-user" },
  };
  expect(parseSelection(frame)).toEqual(frame);
  for (const change of [
    { token: "gho_synthetic" },
    { generation: 0 },
    { generation: true },
    { generation: 2 ** 53 },
    { boot_id: "bad" },
    { account: { host: "github.com", login: "--bad" } },
    { account: { host: "github.com", login: "x", token: "secret" } },
  ])
    expect(() => parseSelection({ ...frame, ...change })).toThrow();
  expect(parseSelectionAck({ generation: 1, status: "selected" })).toEqual({
    generation: 1,
    status: "selected",
  });
  expect(() => parseSelectionAck({ generation: 1, status: "ready" })).toThrow();
});
const subprocessIt = it.skipIf(process.platform === "win32");
async function fixture(
  output: string,
  code = 0,
  linger = false,
  consent: (login: string) => Promise<boolean> = async () => true,
  enabled: () => Promise<boolean> = async () => true,
  stderr = "",
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "sage-gh-metadata-")),
  );
  roots.push(root);
  const executable = join(root, "gh");
  const record = join(root, "record");
  const script = `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),env:process.env}));process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=${code};if(${linger}){process.on("SIGTERM",()=>{});setInterval(()=>{},1000);}`;
  await writeFile(executable, script);
  await chmod(executable, 0o700);
  const key = `${process.platform}-${process.arch}`;
  const before = EXECUTABLE_HASHES[key];
  const beforeSize = EXECUTABLE_SIZES[key];
  EXECUTABLE_SIZES[key] = Buffer.byteLength(script);
  EXECUTABLE_HASHES[key] = createHash("sha256").update(script).digest("hex");
  const selected: unknown[] = [];
  const confirmed: string[] = [];
  const broker = new AccountBroker({
    executable,
    ownedRoot: join(root, "owned"),
    configDir: join(root, "synthetic-config"),
    enabled,
    confirm: async (login) => {
      confirmed.push(login);
      return consent(login);
    },
    select: async (account) => {
      selected.push(account);
      return {
        generation: selected.length,
        status: account ? "selected" : "cleared",
      };
    },
  });
  return {
    broker,
    selected,
    confirmed,
    record,
    executable,
    root,
    restore: () => {
      EXECUTABLE_HASHES[key] = before;
      EXECUTABLE_SIZES[key] = beforeSize;
    },
  };
}
subprocessIt(
  "offers only bounded configured candidate with native consent and fixed metadata path",
  async () => {
    const f = await fixture("synthetic-user\n");
    try {
      expect(await f.broker.choose()).toEqual({ status: "selected" });
      expect(f.confirmed).toEqual(["synthetic-user"]);
      expect(f.selected).toEqual([
        { host: "github.com", login: "synthetic-user" },
      ]);
      const observed = JSON.parse(await readFile(f.record, "utf8"));
      expect(observed.args).toEqual([
        "config",
        "get",
        "user",
        "--host",
        "github.com",
      ]);
      expect(observed.env.GH_CONFIG_DIR).toMatch(/synthetic-config$/);
      expect(observed.env.XDG_DATA_HOME).toMatch(/owned\/data$/);
      for (const key of [
        "PATH",
        "HOME",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GH_DEBUG",
        "HTTPS_PROXY",
        "XDG_CONFIG_HOME",
      ])
        expect(observed.env[key]).toBeUndefined();
      expect(observed.env.GH_TELEMETRY).toBe("0");
      expect(await f.broker.disconnect()).toEqual({ status: "cleared" });
    } finally {
      f.restore();
    }
  },
);
subprocessIt.each([
  ["", 0],
  ["--evil\n", 0],
  ["x\ny\n", 0],
  ["gho_synthetic\n", 1],
  ["x".repeat(8193), 0],
  ["x ", 0],
])(
  "fails unavailable without confirmation on malformed/error %j",
  async (output, code) => {
    const f = await fixture(output as string, code as number);
    try {
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
      expect(f.selected).toEqual([]);
    } finally {
      f.restore();
    }
  },
);

subprocessIt(
  "rejects extra terminal newline instead of offering it as a login",
  async () => {
    const f = await fixture("synthetic-user\n\n");
    try {
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
    } finally {
      f.restore();
    }
  },
);
it("rejects terminal-newline selection identifiers and login labels", () => {
  const valid = {
    version: 1,
    kind: "host_copilot_selection",
    id: "pick",
    boot_id: "a".repeat(32),
    generation: 1,
    account: null,
  };
  for (const change of [
    { id: "pick\n" },
    { boot_id: "a".repeat(32) + "\n" },
    { account: { host: "github.com", login: "synthetic-user\n" } },
  ])
    expect(() => parseSelection({ ...valid, ...change })).toThrow();
});
subprocessIt(
  "disconnect waits for cancelled metadata helper cleanup before acknowledgement",
  async () => {
    const f = await fixture("synthetic-user\n", 0, true);
    let ended = false;
    try {
      const choosing = f.broker.choose().finally(() => {
        ended = true;
      });
      for (let i = 0; i < 200; i++) {
        try {
          await readFile(f.record);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      expect(await f.broker.disconnect()).toEqual({ status: "cleared" });
      expect(ended).toBe(true);
      await choosing;
      expect(f.confirmed).toEqual([]);
    } finally {
      await f.broker.close();
      f.restore();
    }
  },
);

subprocessIt.each([false, "throw"])(
  "native consent %j never selects a credential source",
  async (outcome) => {
    const f = await fixture("synthetic-user\n", 0, false, async () => {
      if (outcome === "throw") throw new Error("synthetic private marker");
      return false;
    });
    try {
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.selected).toEqual([]);
    } finally {
      f.restore();
    }
  },
);
subprocessIt(
  "disconnect invalidates an already-open native confirmation",
  async () => {
    let release: (value: boolean) => void = () => {};
    let entered = () => {};
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = await fixture("synthetic-user\n", 0, false, async () => {
      entered();
      return new Promise<boolean>((resolve) => {
        release = resolve;
      });
    });
    try {
      const pending = f.broker.choose();
      await opened;
      expect(await f.broker.disconnect()).toEqual({ status: "cleared" });
      release(true);
      expect(await pending).toEqual({ status: "unavailable" });
      expect(f.selected).toEqual([null]);
    } finally {
      f.restore();
    }
  },
);
subprocessIt(
  "incompatible or missing managed executable cannot invoke native consent",
  async () => {
    const f = await fixture("synthetic-user\n");
    try {
      await writeFile(f.executable, "tampered");
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      await rm(f.executable);
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
    } finally {
      f.restore();
    }
  },
);
subprocessIt(
  "shutdown cancels metadata and prevents future account use",
  async () => {
    const f = await fixture("synthetic-user\n", 0, true);
    try {
      const pending = f.broker.choose();
      await f.broker.close();
      expect(await pending).toEqual({ status: "unavailable" });
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(await f.broker.disconnect()).toEqual({ status: "unavailable" });
      expect(f.selected).toEqual([]);
    } finally {
      f.restore();
    }
  },
);

import selectionFixtures from "../../tests/fixtures/copilot-selection.json";
it("matches Python's private selection fixtures without admitting renderer control frames", () => {
  for (const row of selectionFixtures) {
    if (row.valid) expect(parseSelection(row.frame)).toEqual(row.frame);
    else expect(() => parseSelection(row.frame)).toThrow();
    expect(() => parseRequest(row.frame)).toThrow();
  }
});

subprocessIt(
  "local mode never starts explicit account discovery or native confirmation",
  async () => {
    const f = await fixture(
      "synthetic-user\n",
      0,
      false,
      async () => true,
      async () => false,
    );
    try {
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
      await expect(readFile(f.record)).rejects.toThrow();
    } finally {
      f.restore();
    }
  },
);
it("rejects non-object, oversized or wrong private selection envelopes", () => {
  for (const frame of [
    null,
    [],
    {},
    {
      version: 1,
      kind: "host_copilot_selection",
      id: "x".repeat(1024),
      boot_id: "a".repeat(32),
      generation: 1,
      account: null,
    },
  ])
    expect(() => parseSelection(frame)).toThrow();
  expect(() => defaultGhConfig("darwin", "relative", "relative")).toThrow();
});
subprocessIt(
  "owned metadata directories must stay empty and cannot follow symlinks",
  async () => {
    const f = await fixture("synthetic-user\n");
    try {
      const data = join(f.root, "owned/data");
      await mkdir(data, { recursive: true });
      await writeFile(join(data, "marker"), "synthetic");
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
      await rm(data, { recursive: true });
      await symlink(join(f.root, "synthetic-target"), data);
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
    } finally {
      f.restore();
    }
  },
);
subprocessIt(
  "unsupported managed source and stderr overflow cannot trigger confirmation",
  async () => {
    const f = await fixture(
      "synthetic-user\n",
      0,
      false,
      async () => true,
      async () => true,
      "synthetic-private-marker".repeat(1000),
    );
    try {
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
      expect(f.confirmed).toEqual([]);
      delete EXECUTABLE_HASHES[`${process.platform}-${process.arch}`];
      expect(await f.broker.choose()).toEqual({ status: "unavailable" });
    } finally {
      f.restore();
    }
  },
);
subprocessIt(
  "helper OS essentials are allowlisted while hostile token/proxy settings stay out",
  async () => {
    const before = {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      GH_TOKEN: process.env.GH_TOKEN,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
    };
    Object.assign(process.env, {
      SystemRoot: "synthetic-system",
      WINDIR: "synthetic-windir",
      GH_TOKEN: "gho_hostile",
      HTTPS_PROXY: "https://hostile.invalid",
    });
    const f = await fixture("synthetic-user\n");
    try {
      expect(await f.broker.choose()).toEqual({ status: "selected" });
      const env = JSON.parse(await readFile(f.record, "utf8")).env;
      expect(env.SystemRoot).toBe("synthetic-system");
      expect(env.WINDIR).toBe("synthetic-windir");
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
    } finally {
      f.restore();
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
it("failed mode lookup and failed clear remain unavailable with no confirmation", async () => {
  let confirmed = 0;
  const broker = new AccountBroker({
    executable: "relative",
    ownedRoot: "relative",
    configDir: "relative",
    enabled: async () => {
      throw new Error("synthetic");
    },
    confirm: async () => {
      confirmed++;
      return true;
    },
    select: async () => {
      throw new Error("synthetic");
    },
  });
  expect(await broker.choose()).toEqual({ status: "unavailable" });
  expect(await broker.disconnect()).toEqual({ status: "unavailable" });
  expect(confirmed).toBe(0);
});

import { handleRequest } from "../main/ipc";
import { createTrust } from "../main/security";
import { pathToFileURL } from "node:url";
import type { CoreRequest, CoreResponse, Settings } from "../shared/contracts";
import type { SelectedAccount } from "../main/copilot-account";
subprocessIt(
  "mode transition fences late native confirmation and requires a fresh choice after local mode",
  async () => {
    const f = await fixture("synthetic-user\n");
    let mode: Settings["ai_mode"] = "assistant";
    let selected: SelectedAccount | null = {
      host: "github.com",
      login: "previous",
    };
    let generation = 0;
    let clearEntered = () => {},
      releaseClear = () => {},
      confirmEntered = () => {},
      releaseConfirm = () => {};
    const clearing = new Promise<void>((resolve) => {
      clearEntered = resolve;
    });
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    const confirming = new Promise<void>((resolve) => {
      confirmEntered = resolve;
    });
    const confirmGate = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    let defer = true;
    const broker = new AccountBroker({
      executable: f.executable,
      ownedRoot: join(f.root, "owned"),
      configDir: join(f.root, "synthetic-config"),
      enabled: async () => mode === "assistant",
      confirm: async () => {
        confirmEntered();
        if (defer) await confirmGate;
        return true;
      },
      select: async (account) => {
        if (account === null && defer) {
          clearEntered();
          await clearGate;
        }
        selected = account;
        return {
          generation: ++generation,
          status: account ? "selected" : "cleared",
        };
      },
    });
    const trust = createTrust({ packaged: true, rendererDir: f.root });
    const sender = { id: 100 };
    const frame = { url: pathToFileURL(join(f.root, "index.html")).href };
    const deps = {
      owner: { webContents: sender, mainFrame: frame },
      trust,
      account: broker,
      openExternal: async () => {},
      core: {
        request: async (request: CoreRequest): Promise<CoreResponse> => {
          if (request.method === "settings.update")
            mode = request.params.ai_mode ?? "local";
          return {
            version: 1,
            id: request.id,
            kind: "response",
            result: {
              ai_mode: mode,
              reasoning_backend: mode === "assistant" ? "copilot" : null,
            },
          };
        },
      },
    };
    const send = (id: string, method: string, params: unknown = {}) =>
      handleRequest(
        { sender, senderFrame: frame },
        { version: 1, kind: "request", id, method, params },
        deps,
      );
    try {
      const changing = send("local", "settings.update", { ai_mode: "local" });
      await clearing;
      const choosing = send("stale-choice", "copilot.chooseAccount");
      await Promise.race([confirming, choosing]);
      releaseClear();
      await changing;
      expect(mode).toBe("local");
      releaseConfirm();
      expect(await choosing).toMatchObject({
        result: { status: "unavailable" },
      });
      expect(selected).toBeNull();
      await send("assistant", "settings.update", {
        ai_mode: "assistant",
        reasoning_backend: "copilot",
      });
      expect(selected).toBeNull();
      defer = false;
      expect(await send("fresh-choice", "copilot.chooseAccount")).toMatchObject(
        { result: { status: "selected" } },
      );
      expect(selected).toEqual({ host: "github.com", login: "synthetic-user" });
    } finally {
      releaseClear();
      releaseConfirm();
      await broker.close();
      f.restore();
    }
  },
  10000,
);

subprocessIt(
  "disconnect fences a simultaneous chooser until revocation completes",
  async () => {
    const f = await fixture("synthetic-user\n");
    try {
      expect(await f.broker.choose()).toEqual({ status: "selected" });
      const disconnecting = f.broker.disconnect();
      const choosing = f.broker.choose();
      expect(await disconnecting).toEqual({ status: "cleared" });
      expect(await choosing).toEqual({ status: "unavailable" });
      expect(f.selected.at(-1)).toBeNull();
      expect(await f.broker.choose()).toEqual({ status: "selected" });
    } finally {
      await f.broker.close();
      f.restore();
    }
  },
);
