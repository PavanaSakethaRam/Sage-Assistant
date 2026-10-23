import {
  _electron,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { CoreRequest } from "../desktop/shared/contracts";
export type Host = {
  root: string;
  app: ElectronApplication;
  page: Page;
  closed: boolean;
  rpc(method: string, params: object): Promise<unknown>;
};
export const python = resolve(
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
export async function launch(
  existing?: string,
  allowUnavailable = false,
): Promise<Host> {
  const root = existing ?? (await mkdtemp(join(tmpdir(), "sage-e2e-")));
  let app: ElectronApplication | undefined;
  try {
    await mkdir(join(root, "userData"), { recursive: true });
    const env: Record<string, string> = {
      HOME: join(root, "home"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    };
    app = await _electron.launch({
      args: [resolve(".cache/e2e/bootstrap.cjs"), root, resolve(".cache/e2e")],
      cwd: resolve("."),
      env,
      chromiumSandbox: true,
      bypassCSP: false,
      timeout: 20000,
    });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      join(root, "userData"),
    );
    const host: Host = {
      root,
      app,
      page,
      closed: false,
      rpc: (method, params) =>
        page.evaluate(
          async ({ method, params }) =>
            window.sage.request({
              version: 1,
              id: crypto.randomUUID(),
              kind: "request",
              method,
              params,
            } as CoreRequest),
          { method, params },
        ),
    };
    if (!allowUnavailable) {
      const readiness = (await host.rpc("settings.get", {})) as {
        kind?: unknown;
        code?: unknown;
      };
      if (readiness.kind !== "response") {
        let fixtureStage = "no_core_event";
        try {
          const lines = (
            await readFile(join(root, "userData/events.jsonl"), "utf8")
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { event?: unknown });
          const started = lines.some((line) => line.event === "started");
          const loopReady = lines.some((line) => line.event === "loop_ready");
          const stopped = lines.some((line) => line.event === "stopped");
          fixtureStage = !started
            ? "no_core_event"
            : stopped
              ? loopReady
                ? "core_stopped_after_loop"
                : "core_stopped_before_loop"
              : loopReady
                ? "core_running_after_loop"
                : "core_started_before_loop";
        } catch {
          // An import failure can happen before the synthetic core writes events.
        }
        const code =
          typeof readiness.code === "string" &&
          /^[a-z_]{1,40}$/.test(readiness.code)
            ? readiness.code
            : "unknown";
        throw new Error(`E2E core readiness ${code}; ${fixtureStage}`);
      }
    }
    return host;
  } catch (error) {
    // A failed initialization still owns the acquired app and any new root.
    try {
      await app?.close();
    } catch {
      // Preserve the original initialization error.
    }
    if (!existing) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        // Preserve the original initialization error.
      }
    }
    throw error;
  }
}
export async function close(host: Host, remove = true) {
  if (!host.closed) {
    host.closed = true;
    await host.app.close();
    const pids = [...new Set((await events(host)).map((e) => e.pid))];
    await expect
      .poll(() =>
        pids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }),
      )
      .toEqual([]);
  }
  if (remove) await rm(host.root, { recursive: true, force: true });
}
export async function createDraft(host: Host, title: string, body: string) {
  await host.page
    .getByRole("button", { name: "New note", exact: true })
    .click();
  await host.page
    .getByRole("textbox", { name: "Note title", exact: true })
    .fill(title);
  await host.page
    .getByRole("textbox", { name: "Note body", exact: true })
    .fill(body);
  await host.page
    .getByRole("button", { name: "Review note", exact: true })
    .click();
  await expect(host.page.getByLabel("Literal note body")).toHaveText(body, {
    useInnerText: false,
  });
}
export function database(host: Host): Promise<{
  notes: { title: string; body: string }[];
  operations: number;
  revisions: number;
}> {
  const script =
    "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps({'notes':[{'title':r[0],'body':r[1]} for r in c.execute('SELECT title,body FROM notes ORDER BY created_at')], 'operations':c.execute('SELECT count(*) FROM operations').fetchone()[0], 'revisions':c.execute('SELECT count(*) FROM revisions WHERE title IS NOT NULL').fetchone()[0]}))";
  return Promise.resolve(
    JSON.parse(
      execFileSync(
        python,
        ["-I", "-c", script, join(host.root, "userData/data/sage.sqlite3")],
        { encoding: "utf8" },
      ),
    ),
  );
}
export async function assistant(host: Host) {
  await host.page.getByRole("radio", { name: "Connect an assistant" }).click();
  await expect(host.page.getByText("Actual mode: assistant")).toBeVisible();
  await expect(
    host.page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
}
export async function events(host: Host) {
  return (await readFile(join(host.root, "userData/events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event: string; pid: number });
}
export async function waitEvent(host: Host, name: string, count = 1) {
  await expect
    .poll(
      async () => (await events(host)).filter((e) => e.event === name).length,
    )
    .toBeGreaterThanOrEqual(count)
    .catch(async () => {
      throw new Error(
        `Missing fixture event ${name}; events=${JSON.stringify(await events(host))}; state=${await host.page.getByLabel("Conversation status").textContent()}`,
      );
    });
}
