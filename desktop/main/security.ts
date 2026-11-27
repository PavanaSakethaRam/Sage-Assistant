/** Main-process trust decisions. No renderer-supplied deployment configuration. */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function createWindowOptions(preload: string) {
  if (!isAbsolute(preload)) throw new TypeError("Invalid preload");
  return {
    width: 1000,
    height: 760,
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      devTools: false,
    },
  };
}
export type Trust = {
  documentUrl: string;
  documentAllowed(url: string): boolean;
  resourceAllowed(url: string): boolean;
  csp: string;
};
export function createTrust(options: {
  packaged: boolean;
  rendererDir: string;
  devServerUrl?: string;
}): Trust {
  const root = resolve(options.rendererDir);
  if (options.packaged && options.devServerUrl)
    throw new TypeError("Invalid UI origin");
  let dev: URL | undefined;
  if (options.devServerUrl) {
    dev = new URL(options.devServerUrl);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(dev.hostname) ||
      dev.protocol !== "http:" ||
      dev.username ||
      dev.password ||
      dev.pathname !== "/" ||
      dev.search ||
      dev.hash
    )
      throw new TypeError("Invalid UI origin");
  }
  const documentUrl =
    dev?.href ?? pathToFileURL(resolve(root, "index.html")).href;
  return {
    documentUrl,
    documentAllowed(url) {
      return url === documentUrl;
    },
    resourceAllowed(url) {
      try {
        const candidate = new URL(url);
        if (dev)
          return (
            candidate.origin === dev.origin ||
            (candidate.protocol === "ws:" && candidate.host === dev.host)
          );
        if (
          candidate.protocol !== "file:" ||
          candidate.host ||
          candidate.search
        )
          return false;
        const local = fileURLToPath(candidate);
        const path = relative(root, local);
        return (
          path !== "" &&
          path !== ".." &&
          !path.startsWith(`..${sep}`) &&
          !isAbsolute(path)
        );
      } catch {
        return false;
      }
    },
    csp: `default-src 'none'; script-src 'self'; style-src 'self'${dev ? " 'unsafe-inline'" : ""}; img-src 'self'; font-src 'self'; connect-src ${dev ? `${dev.origin} ws://${dev.host}` : "'none'"}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; media-src 'none'`,
  };
}
export type SenderEvent = {
  sender: unknown;
  senderFrame: { url: string } | null;
};
export type WindowOwner = { webContents: unknown; mainFrame: unknown };
export function isTrustedSender(
  event: SenderEvent,
  owner: WindowOwner,
  trust: Trust,
): boolean {
  return (
    event.sender === owner.webContents &&
    event.senderFrame !== null &&
    event.senderFrame === owner.mainFrame &&
    trust.documentAllowed(event.senderFrame.url)
  );
}
export { validateExternalUrl } from "../shared/external-url";
export type WindowGuard = {
  on(
    name: string,
    callback: (event: { preventDefault(): void }) => void,
  ): unknown;
  setWindowOpenHandler(callback: () => { action: "deny" }): void;
};
export function guardWindow(contents: WindowGuard): void {
  for (const name of [
    "will-navigate",
    "will-frame-navigate",
    "will-redirect",
    "will-attach-webview",
  ])
    contents.on(name, (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
export type SessionGuard = {
  webRequest: {
    onBeforeRequest(
      callback: (
        details: { url: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void,
    ): void;
  };
  setPermissionCheckHandler(callback: () => boolean): void;
  setPermissionRequestHandler(
    callback: (
      contents: unknown,
      permission: unknown,
      callback: (allow: boolean) => void,
    ) => void,
  ): void;
};
export function guardSession(session: SessionGuard, trust: Trust): void {
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !trust.resourceAllowed(details.url) }),
  );
}
