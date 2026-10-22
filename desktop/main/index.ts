import { app, BrowserWindow, ipcMain, session, shell, dialog } from "electron";
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
import { AccountBroker, defaultGhConfig } from "./copilot-account";
import {
  REQUEST_CHANNEL,
  PROGRESS_CHANNEL,
  type Settings,
} from "../shared/contracts";
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
let core: CoreProcess | undefined;
let window: BrowserWindow | undefined;
let closing = false;
let account: AccountBroker | undefined;
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
    ipcMain.handle(REQUEST_CHANNEL, (event, value: unknown) =>
      handleRequest(event, value, {
        owner: {
          webContents: owned.webContents,
          mainFrame: owned.webContents.mainFrame,
        },
        trust,
        core: child,
        account,
        openExternal: (url) => shell.openExternal(url),
      }),
    );
    const unsubscribe = child.onProgress((progress) => {
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
        owned.webContents.send(PROGRESS_CHANNEL, progress);
    });
    owned.once("closed", () => {
      unsubscribe();
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
  void Promise.all([account?.close(), core?.close()]).finally(() => app.quit());
});
