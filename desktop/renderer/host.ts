import {
  parseRequest,
  parseResponse,
  type CoreRequest,
  type Method,
  type Params,
  type Results,
  type SageApi,
} from "../shared/contracts";
let sequence = 0;
export function requestId() {
  return `ui_${++sequence}`;
}
export async function call<M extends Method>(
  api: SageApi,
  method: M,
  params: Params[M],
  id = requestId(),
): Promise<Results[M]> {
  const request = parseRequest({
    version: 1,
    id,
    kind: "request",
    method,
    params,
  } as CoreRequest);
  const response = parseResponse(await api.request(request), method);
  if (response.kind === "error") throw Error(response.code);
  if (response.id !== id) throw Error("Response correlation failed");
  return response.result as Results[M];
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
export function validRequest<M extends Method>(method: M, params: Params[M]) {
  try {
    parseRequest({
      version: 1,
      id: "validate",
      kind: "request",
      method,
      params,
    });
    return true;
  } catch {
    return false;
  }
}
