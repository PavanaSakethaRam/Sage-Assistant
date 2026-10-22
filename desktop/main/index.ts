import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join, resolve } from "node:path";
import { startCore, deployment, type CoreProcess } from "./core-process";
import {
  createTrust,
  createWindowOptions,
  guardSession,
  guardWindow,
  isTrustedSender,
} from "./security";
import { handleRequest } from "./ipc";
import { REQUEST_CHANNEL, PROGRESS_CHANNEL } from "../shared/contracts";
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
let core: CoreProcess | undefined;
let window: BrowserWindow | undefined;
let closing = false;
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
    core = startCore(
      deployment({
        packaged: app.isPackaged,
        projectDir,
        resourcesDir: process.resourcesPath,
        dataDir: app.getPath("userData"),
        platform: process.platform,
      }),
    );
    window = new BrowserWindow({
      ...createWindowOptions(join(__dirname, "preload.cjs")),
      webPreferences: {
        ...createWindowOptions(join(__dirname, "preload.cjs")).webPreferences,
        session: isolated,
      },
    });
    const owned = window;
    const child = core;
    guardWindow(owned.webContents);
    ipcMain.handle(REQUEST_CHANNEL, (event, value: unknown) =>
      handleRequest(event, value, {
        owner: {
          webContents: owned.webContents,
          mainFrame: owned.webContents.mainFrame,
        },
        trust,
        core: child,
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
  void (core?.close() ?? Promise.resolve()).finally(() => app.quit());
});
