import {
  failure,
  parseRequest,
  parseResponse,
  type CoreRequest,
  type CoreResponse,
  type Method,
  type PairView,
} from "../shared/contracts";
import type { CodeJobView } from "../shared/coding-contracts";
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
    editor?: {
      request(
        method:
          | "editor.pair"
          | "editor.status"
          | "editor.confirm"
          | "editor.disconnect",
      ): Promise<PairView | null>;
      invalidate(): Promise<void>;
      cached(jobId: string): CodeJobView | null | undefined;
    };
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
      [
        "editor.pair",
        "editor.status",
        "editor.confirm",
        "editor.disconnect",
      ].includes(request.method)
    ) {
      const result =
        (await deps.editor?.request(
          request.method as Extract<Method, `editor.${string}`>,
        )) ?? null;
      return parseResponse(
        { version: 1, id: request.id, kind: "response", result },
        request.method,
      );
    }
    if (request.method === "coding.get") {
      const cached = deps.editor?.cached(request.params.job_id);
      if (cached !== undefined)
        return cached === null
          ? failure(request.id, "not_found")
          : parseResponse(
              { version: 1, id: request.id, kind: "response", result: cached },
              request.method,
            );
    }
    if (request.method === "coding.start") {
      const cached = deps.editor?.cached(request.params.job_id);
      if (
        !cached ||
        cached.state !== "context_ready" ||
        cached.binding.revision !== request.params.revision ||
        cached.account_generation !== request.params.account_generation ||
        cached.model !== (request.params.model ?? null)
      )
        return failure(request.id, "invalid_request");
    }

    if (
      request.method === "copilot.chooseAccount" ||
      request.method === "copilot.disconnect"
    ) {
      await deps.editor?.invalidate();
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
      const invalidated = deps.editor?.invalidate();
      const finish = deps.account?.beginModeTransition();
      try {
        await invalidated;
        if (
          request.params.ai_mode !== undefined &&
          request.params.ai_mode !== "assistant"
        )
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
