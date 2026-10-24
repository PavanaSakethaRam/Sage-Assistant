import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  shell,
  dialog,
  clipboard,
} from "electron";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startCore, deployment, type CoreProcess } from "./core-process";
import {
  createTrust,
  createWindowOptions,
  guardSession,
  guardWindow,
  isTrustedSender,
} from "./security";
import { handleRequest } from "./ipc";
import { parseCodeJobView } from "../shared/coding-contracts";
import { EditorBridgeHost } from "./editor-bridge";
import { AccountBroker, defaultGhConfig } from "./copilot-account";
import {
  REQUEST_CHANNEL,
  PROGRESS_CHANNEL,
  type Settings,
  type RendererEvent,
  type PairView,
  parseRendererEvent,
} from "../shared/contracts";
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
let core: CoreProcess | undefined;
let window: BrowserWindow | undefined;
let closing = false;
let account: AccountBroker | undefined;
let closeEditor: (() => Promise<void>) | undefined;
app.enableSandbox();
void app
  .whenReady()
  .then(async () => {
    const projectDir = resolve(__dirname, "../..");
    const rendererDir = join(__dirname, "../renderer/main_window");
    const devServerUrl =
      typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "string"
        ? MAIN_WINDOW_VITE_DEV_SERVER_URL
        : undefined;
    const trust = createTrust({
      packaged: app.isPackaged,
      rendererDir,
      devServerUrl,
    });
    const isolated = session.fromPartition("sage-ui");
    guardSession(isolated, trust);
    isolated.webRequest.onHeadersReceived((details, callback) =>
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [trust.csp],
        },
      }),
    );
    const configured = deployment({
      packaged: app.isPackaged,
      projectDir,
      resourcesDir: process.resourcesPath,
      dataDir: app.getPath("userData"),
      platform: process.platform,
    });
    core = startCore(configured);
    window = new BrowserWindow({
      ...createWindowOptions(join(__dirname, "preload.cjs")),
      webPreferences: {
        ...createWindowOptions(join(__dirname, "preload.cjs")).webPreferences,
        session: isolated,
      },
    });
    const owned = window;
    const child = core;
    account = new AccountBroker({
      executable: configured.ghPath!,
      ownedRoot: join(app.getPath("userData"), "gh-metadata"),
      configDir: defaultGhConfig(
        process.platform,
        app.getPath("home"),
        app.getPath("appData"),
      ),
      enabled: async () => {
        const response = await child.request({
          version: 1,
          kind: "request",
          id: randomUUID(),
          method: "settings.get",
          params: {},
        });
        return (
          response.kind === "response" &&
          (response.result as Settings).ai_mode === "assistant"
        );
      },
      confirm: async (login) =>
        (
          await dialog.showMessageBox(owned, {
            type: "question",
            title: "Use existing GitHub account",
            buttons: ["Use account", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            message: `Use configured account candidate ${login} on github.com?`,
            detail:
              "Allow Sage to read this account's existing protected credential for requested Copilot operations until disconnect or restart. The configured label does not verify its credential source, identity, health or Copilot access. An explicit connection test performs those checks and consumes model quota. Configure the account manually outside Sage if unavailable.",
          })
        ).response === 0,
      select: (selected) => child.selectAccount(selected),
    });
    guardWindow(owned.webContents);
    const publish = (value: RendererEvent) => {
      if (
        !owned.isDestroyed() &&
        isTrustedSender(
          {
            sender: owned.webContents,
            senderFrame: owned.webContents.mainFrame,
          },
          {
            webContents: owned.webContents,
            mainFrame: owned.webContents.mainFrame,
          },
          trust,
        )
      )
        owned.webContents.send(PROGRESS_CHANNEL, parseRendererEvent(value));
    };
    let bridge: EditorBridgeHost | undefined;
    let editorEpoch = 0;
    let pairing = false;
    let currentJobId: string | undefined;
    const invalidate = async () => {
      const previous = bridge;
      bridge = undefined;
      editorEpoch++;
      // close invalidates local ownership synchronously, before any Core await.
      await previous?.close();
    };
    closeEditor = invalidate;
    const stopLifecycle = child.onLifecycle(() => {
      if (bridge) void invalidate().catch(() => {});
    });
    const editor = {
      invalidate,
      cached(jobId: string) {
        return (
          bridge?.codingJobStatus(jobId) ??
          (jobId === currentJobId ? null : undefined)
        );
      },
      async request(
        method:
          | "editor.pair"
          | "editor.status"
          | "editor.confirm"
          | "editor.disconnect",
      ): Promise<PairView | null> {
        if (closing || owned.isDestroyed()) return null;
        if (method === "editor.disconnect") {
          await invalidate();
          return null;
        }
        if (method === "editor.status") {
          const view = bridge?.pairView() ?? null,
            job = bridge?.currentCodingJob();
          if (job) publish({ version: 1, kind: "coding_status", job });
          return view;
        }
        if (pairing) return null;
        pairing = true;
        try {
          if (method === "editor.pair") {
            await invalidate();
            const epoch = editorEpoch;
            // A metadata-only request starts the owned generation; no token or model.
            await child.request({
              version: 1,
              kind: "request",
              id: randomUUID(),
              method: "settings.get",
              params: {},
            });
            if (epoch !== editorEpoch || closing || !child.running) return null;
            const generation = child.launchGeneration;
            const valid = () =>
              !closing &&
              child.running &&
              child.launchGeneration === generation;
            const host = new EditorBridgeHost({
              onData: () => {},
              onPair: () => {},
              onClose: (view) => {
                if (view)
                  publish({
                    version: 1,
                    kind: "coding_cleared",
                    pair_id: view.pair_id,
                  });
              },
              onJobStatus: (job) => {
                if (bridge === host && valid()) {
                  currentJobId = job.binding.job_id;
                  publish({ version: 1, kind: "coding_status", job });
                }
              },
              codingControl: (value) => {
                if (!valid()) throw Error("Editor unavailable");
                return child.codingControl(value);
              },
              codingStatus: async (job_id) => {
                if (!valid()) throw Error("Editor unavailable");
                const response = await child.request({
                  version: 1,
                  kind: "request",
                  id: randomUUID(),
                  method: "coding.get",
                  params: { job_id },
                });
                if (!valid() || response.kind !== "response")
                  throw Error("Editor unavailable");
                return parseCodeJobView(response.result);
              },
            });
            bridge = host;
            const ticket = await host.start();
            if (bridge !== host || epoch !== editorEpoch || !valid()) {
              await host.close();
              return null;
            }
            const encoded = Buffer.from(JSON.stringify(ticket)).toString(
              "base64url",
            );
            const choice = await dialog.showMessageBox(owned, {
              type: "question",
              title: "Pair local VS Code",
              buttons: ["Copy pairing ticket", "Cancel"],
              defaultId: 1,
              cancelId: 1,
              message: "Pair one trusted local single-folder VS Code window",
              detail: `One-use ticket expires in 60 seconds. Paste it into Sage: Pair in the intended local VS Code window, then compare its window, folder and challenge in both apps. Copy writes this short-lived capability to your clipboard only when chosen. No source or model is accessed.\n\n${encoded}`,
            });
            if (bridge !== host || epoch !== editorEpoch || !valid())
              return null;
            // A cancelled/expired dialog cannot copy or reopen a listener.
            if (choice.response !== 0 || !host.pairingAvailable()) {
              await invalidate();
              return null;
            }
            clipboard.writeText(encoded);
            return host.pairView();
          }
          const host = bridge,
            view = host?.pairView(),
            epoch = editorEpoch;
          if (!host || !view || view.status !== "awaiting_confirmation")
            return view ?? null;
          const choice = await dialog.showMessageBox(owned, {
            type: "question",
            title: "Confirm local editor destination",
            buttons: ["Confirm this window and folder", "Cancel"],
            defaultId: 1,
            cancelId: 1,
            message: `Window ${view.window_id} · challenge ${view.challenge}`,
            detail: `Confirm the same local folder and challenge in VS Code before sharing selected context.\n${view.root_uri}\nRoot: ${view.root_id}`,
          });
          if (
            bridge !== host ||
            epoch !== editorEpoch ||
            host.pairView()?.pair_id !== view.pair_id
          )
            return null;
          if (choice.response !== 0) {
            await invalidate();
            return null;
          }
          const confirmed = await host.confirm(view.pair_id);
          return bridge === host && epoch === editorEpoch ? confirmed : null;
        } catch {
          await invalidate();
          return null;
        } finally {
          pairing = false;
        }
      },
    };
    ipcMain.handle(REQUEST_CHANNEL, (event, value: unknown) =>
      handleRequest(event, value, {
        owner: {
          webContents: owned.webContents,
          mainFrame: owned.webContents.mainFrame,
        },
        trust,
        core: child,
        account,
        editor,
        openExternal: (url) => shell.openExternal(url),
      }),
    );
    const unsubscribe = child.onProgress(publish);
    owned.once("closed", () => {
      unsubscribe();
      stopLifecycle();
      void invalidate().catch(() => {});
      ipcMain.removeHandler(REQUEST_CHANNEL);
      window = undefined;
      app.quit();
    });
    await owned.loadURL(trust.documentUrl);
    owned.show();
  })
  .catch(() => {
    console.error("desktop_startup_failed");
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (closing) return;
  closing = true;
  event.preventDefault();
  const editorClose = closeEditor?.();
  const coreClose = core?.close();
  void Promise.allSettled([editorClose, account?.close(), coreClose]).then(() =>
    app.quit(),
  );
});
