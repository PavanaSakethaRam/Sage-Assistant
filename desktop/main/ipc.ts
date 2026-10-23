import {
  failure,
  parseRequest,
  parseResponse,
  type CoreRequest,
  type CoreResponse,
} from "../shared/contracts";
import {
  isTrustedSender,
  validateExternalUrl,
  type SenderEvent,
  type Trust,
  type WindowOwner,
} from "./security";
export async function handleRequest(
  event: SenderEvent,
  value: unknown,
  deps: {
    owner: WindowOwner;
    trust: Trust;
    core: { request(request: CoreRequest): Promise<CoreResponse> };
    openExternal(url: string): Promise<void>;
    account?: {
      beginModeTransition(): () => void;
      choose(): Promise<{ status: "selected" | "cleared" | "unavailable" }>;
      disconnect(): Promise<{ status: "selected" | "cleared" | "unavailable" }>;
    };
  },
): Promise<CoreResponse> {
  let identifier: string | null = null;
  try {
    if (!isTrustedSender(event, deps.owner, deps.trust))
      return failure(null, "invalid_request");
    const request = parseRequest(value);
    identifier = request.id;
    if (
      request.method === "copilot.chooseAccount" ||
      request.method === "copilot.disconnect"
    ) {
      const result = deps.account
        ? await (request.method === "copilot.chooseAccount"
            ? deps.account.choose()
            : deps.account.disconnect())
        : { status: "unavailable" };
      return parseResponse(
        { version: 1, id: request.id, kind: "response", result },
        request.method,
      );
    }
    if (request.method === "settings.update") {
      const finish = deps.account?.beginModeTransition();
      try {
        if (request.params.ai_mode !== "assistant")
          await deps.account?.disconnect();
        return parseResponse(await deps.core.request(request), request.method);
      } finally {
        finish?.();
      }
    }
    if (request.method === "external.open") {
      const url = validateExternalUrl(request.params.url);
      try {
        await deps.openExternal(url);
        return {
          version: 1,
          id: request.id,
          kind: "response",
          result: { status: "opened" },
        };
      } catch {
        return {
          version: 1,
          id: request.id,
          kind: "response",
          result: { status: "unavailable" },
        };
      }
    }
    return parseResponse(await deps.core.request(request), request.method);
  } catch {
    return failure(identifier, "invalid_request");
  }
}
