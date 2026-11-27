import { contextBridge, ipcRenderer } from "electron";
import {
  REQUEST_CHANNEL,
  PROGRESS_CHANNEL,
  parseRequest,
  parseResponse,
  parseRendererEvent,
  type SageApi,
} from "../shared/contracts";
const api: SageApi = {
  async request(value) {
    const request = parseRequest(value);
    const response = parseResponse(
      await ipcRenderer.invoke(REQUEST_CHANNEL, request),
      request.method,
    );
    if (response.id !== request.id && response.id !== null)
      throw new TypeError("Invalid response");
    return response;
  },
  onProgress(handler) {
    if (typeof handler !== "function") throw new TypeError("Invalid handler");
    const listener = (_event: unknown, value: unknown) => {
      try {
        handler(parseRendererEvent(value));
      } catch {
        /* Discard invalid progress; no event object crosses the bridge. */
      }
    };
    ipcRenderer.on(PROGRESS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(PROGRESS_CHANNEL, listener);
    };
  },
};
contextBridge.exposeInMainWorld("sage", Object.freeze(api));
