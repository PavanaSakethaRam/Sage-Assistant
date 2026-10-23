import { useEffect, useRef, useState } from "react";
import type { Proposal, Settings, SageApi } from "../shared/contracts";
import { call, message, requestId, validRequest } from "./host";
import { SafeMarkdown } from "./SafeMarkdown";
export function Conversation({
  api,
  settings,
  busy,
  draftVersion,
  onProposal,
}: {
  api: SageApi;
  settings: Settings | null;
  busy: boolean;
  draftVersion: number;
  onProposal: (p: Proposal, version: number) => void;
}) {
  const [text, setText] = useState(""),
    [context, setContext] = useState(""),
    [output, setOutput] = useState(""),
    [status, setStatus] = useState(""),
    [pending, setPending] = useState(false);
  const active = useRef<string | null>(null),
    alive = useRef(true),
    generation = useRef(0);
  const backend = settings?.reasoning_backend;
  const params = {
    user_text: text,
    attached_context: context ? [context] : [],
    backend: backend ?? ("local" as const),
  };
  async function cancel() {
    const id = active.current;
    if (!id) return;
    const token = ++generation.current;
    active.current = null;
    setPending(false);
    setStatus("Response cancelled");
    try {
      const r = await call(api, "reasoning.cancel", { request_id: id });
      if (
        alive.current &&
        token === generation.current &&
        r.status !== "cancelled"
      )
        setStatus("Cancellation unconfirmed; late result ignored");
    } catch (e) {
      if (alive.current && token === generation.current)
        setStatus(
          `Cancellation unconfirmed: ${message(e)}; late result ignored`,
        );
    }
  }
  useEffect(() => {
    alive.current = true;
    const unsubscribe = api.onProgress((p) => {
      if (p.id === active.current) setStatus(`Pending — task ${p.task_id}`);
    });
    return () => {
      alive.current = false;
      unsubscribe();
      const id = active.current;
      active.current = null;
      if (id)
        void call(api, "reasoning.cancel", { request_id: id }).catch(() => {});
    };
  }, [api]);
  useEffect(() => {
    if (busy || !backend) void cancel();
  }, [busy, backend]);
  async function send() {
    generation.current++;
    const id = requestId(),
      version = draftVersion;
    active.current = id;
    setPending(true);
    setStatus("Pending");
    setOutput("");
    try {
      const result = await call(api, "reasoning.start", params, id);
      if (!alive.current || active.current !== id) return;
      setStatus(result.status === "unavailable" ? result.code : result.status);
      if ("text" in result) {
        setOutput(result.text);
        if (result.status === "completed" && result.proposal)
          onProposal(result.proposal, version);
      }
    } catch (e) {
      if (alive.current && active.current === id)
        setStatus(`Response failed: ${message(e)}`);
    } finally {
      if (alive.current && active.current === id) {
        active.current = null;
        setPending(false);
      }
    }
  }
  return (
    <section aria-labelledby="conversation-heading">
      <h2 id="conversation-heading">Conversation</h2>
      <p>
        Typed requests use only the selected reviewed backend. Local notes
        remain available below.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label>
          Message
          <textarea
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p>{[...text].length} / 32,000 code points</p>
        <label>
          Attached context (optional)
          <textarea
            aria-label="Attached context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        </label>
        <p>{[...context].length} / 64,000 code points</p>
        <button
          disabled={
            pending ||
            busy ||
            !backend ||
            !validRequest("reasoning.start", params)
          }
        >
          Send message
        </button>
        {pending && (
          <button type="button" onClick={() => void cancel()}>
            Cancel response
          </button>
        )}
      </form>
      <p role="status" aria-label="Conversation status">
        {status}
      </p>
      {output && <SafeMarkdown text={output} api={api} />}
    </section>
  );
}
