import { app, session, shell, ipcMain } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
const root = process.argv[2];
for (const key of [
  "userData",
  "sessionData",
  "temp",
  "home",
  "appData",
] as const) {
  const path = join(root, key);
  mkdirSync(path, { recursive: true });
  app.setPath(key, path);
}
const evidence = {
  requests: [] as { url: string; cancel: boolean }[],
  external: [] as string[],
  handlers: new Map<string, unknown>(),
  guardInstalled: false,
};
Object.assign(globalThis, { __sageE2E: evidence });
shell.openExternal = async (url) => {
  evidence.external.push(url);
};
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, callback) => {
  evidence.handlers.set(channel, callback);
  handle(channel, callback);
};
const partition = session.fromPartition.bind(session);
session.fromPartition = (...args) => {
  const target = partition(...args);
  const register = target.webRequest.onBeforeRequest.bind(target.webRequest);
  target.webRequest.onBeforeRequest = (listener) => {
    if (listener !== null && typeof listener !== "function")
      throw new TypeError("Unexpected test registration");
    evidence.guardInstalled = !!listener;
    register(
      listener
        ? (details, callback) =>
            listener(details, (result) => {
              if (!details.url.startsWith("file:"))
                evidence.requests.push({
                  url: details.url,
                  cancel: result.cancel === true,
                });
              callback(result);
            })
        : null,
    );
  };
  return target;
};
createRequire(join(process.cwd(), "package.json"))(
  join(process.argv[3], "build/main.cjs"),
);
