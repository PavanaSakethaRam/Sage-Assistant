import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionResult,
  Page,
  Proposal,
  Results,
  SageApi,
  Settings,
  TaskSummary,
} from "../shared/contracts";
import { call, message } from "./host";
import { Development } from "./Development";
import { Setup } from "./Setup";
import { Conversation } from "./Conversation";
import { NoteReview } from "./NoteReview";
import { Notes } from "./Notes";
export function App({ api = window.sage }: { api?: SageApi }) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false),
    [draft, setDraft] = useState<{
      proposal: Proposal | null;
      reviewRequired: boolean;
      key: number;
    } | null>(null),
    [version, setVersion] = useState(0),
    [refresh, setRefresh] = useState(0),
    [tasks, setTasks] = useState<Page<TaskSummary>>({
      items: [],
      next_offset: null,
    }),
    [offset, setOffset] = useState(0),
    [task, setTask] = useState<Results["tasks.get"] | null>(null),
    [status, setStatus] = useState(""),
    [savedReceipt, setSavedReceipt] = useState("");
  const generation = useRef(0),
    taskGeneration = useRef(0),
    alive = useRef(true),
    terminalOutcomes = useRef(
      new Map<string, ActionResult & { status: "succeeded" | "cancelled" }>(),
    );
  const updateSettings = useCallback(
    (s: Settings | null) => setSettings(s),
    [],
  );
  const dirty = () => {
    setVersion(++generation.current);
  };
  useEffect(() => {
    let alive = true;
    void call(api, "tasks.list", { limit: 20, offset }).then(
      (p) => {
        if (alive)
          setTasks({
            ...p,
            items: p.items.map((item) =>
              terminalOutcomes.current.has(item.id)
                ? {
                    ...item,
                    status: terminalOutcomes.current.get(item.id)!.status,
                  }
                : item,
            ),
          });
      },
      (e) => {
        if (alive) setStatus(`Task history unavailable: ${message(e)}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, offset, refresh]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      taskGeneration.current++;
    };
  }, []);
  function reconciledTask(value: Results["tasks.get"]): Results["tasks.get"] {
    const outcome = terminalOutcomes.current.get(value.id);
    return outcome
      ? {
          ...value,
          status: outcome.status,
          proposal: null,
          review_required: false,
          outcome,
        }
      : value;
  }
  function reconcileOutcome(
    task_id: string,
    outcome: ActionResult,
    proposal_id?: string,
  ) {
    if (
      !alive.current ||
      (outcome.status !== "succeeded" && outcome.status !== "cancelled")
    )
      return;
    const terminal = { ...outcome, status: outcome.status };
    // The acknowledgement fences this identity, independently of selected detail.
    terminalOutcomes.current.set(task_id, terminal);
    setDraft((current) =>
      current?.proposal?.task_id === task_id &&
      (!proposal_id || current.proposal.id === proposal_id)
        ? outcome.status === "cancelled"
          ? null
          : { ...current, proposal: null }
        : current,
    );
    setTask((current) =>
      current?.id === task_id ? reconciledTask(current) : current,
    );
    setTasks((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === task_id ? { ...item, status: terminal.status } : item,
      ),
    }));
    setRefresh((v) => v + 1);
  }
  function openDraft(proposal: Proposal | null, reviewRequired = false) {
    if (proposal && terminalOutcomes.current.has(proposal.task_id)) return;
    dirty();
    setDraft({ proposal, reviewRequired, key: generation.current });
  }
  async function getTask(task_id: string) {
    const token = ++taskGeneration.current;
    try {
      const t = await call(api, "tasks.get", { task_id });
      if (token === taskGeneration.current) {
        setTask(reconciledTask(t));
        setStatus("");
      }
    } catch (e) {
      if (token === taskGeneration.current)
        setStatus(`Task unavailable: ${message(e)}`);
    }
  }
  async function cancelTask(task_id: string) {
    const token = ++taskGeneration.current;
    try {
      const result = await call(api, "tasks.cancel", { task_id });
      if (!alive.current) return;
      if (result.status === "cancelled") reconcileOutcome(task_id, result);
      else setRefresh((v) => v + 1);
      if (token === taskGeneration.current) {
        if (result.status !== "cancelled") setTask(null);
        setStatus(
          `Task ${result.status}${result.diagnostic ? ` — ${result.diagnostic}` : ""}`,
        );
      }
    } catch (e) {
      if (token === taskGeneration.current)
        setStatus(`Task cancellation failed: ${message(e)}`);
    }
  }
  return (
    <main>
      <header>
        <p className="eyebrow">SAGE · FOUNDATION</p>
        <h1>Your notes, with review before saving.</h1>
        <p>Local notes and typed conversation. Provider access is explicit.</p>
      </header>
      <div className="workspace">
        <div>
          <Setup api={api} onSettings={updateSettings} onBusy={setBusy} />
          <Conversation
            api={api}
            settings={settings}
            busy={busy}
            draftVersion={version}
            onProposal={(p, v) => {
              if (v === generation.current) openDraft(p);
              else
                setStatus(
                  "Response draft ignored because local review changed.",
                );
            }}
          />
        </div>
        <div>
          <section aria-label="Local notes">
            <h2>Local notes</h2>
            <p>
              Create a note without connecting an assistant or running a model.
            </p>
            <button onClick={() => openDraft(null)}>New note</button>
          </section>
          {draft && (
            <NoteReview
              key={draft.key}
              api={api}
              proposal={draft.proposal}
              reviewRequired={draft.reviewRequired}
              onChange={dirty}
              onProposal={(proposal) => {
                setDraft((current) =>
                  current?.key === draft.key
                    ? terminalOutcomes.current.has(proposal.task_id)
                      ? null
                      : { ...current, proposal }
                    : current,
                );
              }}
              onOutcome={(result, identity) => {
                if (result.task_id !== identity.task_id) return;
                if (result.status === "cancelled")
                  reconcileOutcome(identity.task_id, result, identity.id);
                else if (result.status === "succeeded" && result.note_id) {
                  reconcileOutcome(identity.task_id, result, identity.id);
                  setSavedReceipt(
                    `Task succeeded · saved note ${result.note_id}`,
                  );
                }
              }}
            />
          )}
          <p role="status" aria-label="Saved note receipt">
            {savedReceipt}
          </p>
          <Notes api={api} refresh={refresh} />
        </div>
      </div>
      {!busy && <Development api={api} />}
      <section aria-labelledby="tasks-heading">
        <h2 id="tasks-heading">Task history</h2>
        <p>
          Interrupted tasks are not replayed. Open one task to inspect a
          retained draft or recorded outcome.
        </p>
        <button onClick={() => setRefresh((v) => v + 1)}>
          Refresh history
        </button>
        <ul>
          {tasks.items.map((t) => (
            <li key={t.id}>
              <button onClick={() => void getTask(t.id)}>
                {t.id} · {t.status}
              </button>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Previous tasks
          </button>
          <button
            disabled={tasks.next_offset === null}
            onClick={() => setOffset(tasks.next_offset!)}
          >
            Next tasks
          </button>
        </div>
        {task && (
          <article aria-label="Task details">
            <h3>
              {task.id} · {task.status}
            </h3>
            {task.outcome && (
              <p>
                Recorded outcome: {task.outcome.status}
                {task.outcome.note_id
                  ? ` · saved note ${task.outcome.note_id}`
                  : ""}
                {task.outcome.diagnostic ? ` · ${task.outcome.diagnostic}` : ""}
              </p>
            )}
            {task.proposal && (
              <button
                onClick={() => openDraft(task.proposal, task.review_required)}
              >
                Open retained draft
              </button>
            )}
            {["pending", "reasoning"].includes(task.status) && (
              <button onClick={() => void cancelTask(task.id)}>
                Cancel task
              </button>
            )}
            {!task.proposal && <p>No retained draft text available.</p>}
          </article>
        )}
        <p role="status" aria-label="Task history status">
          {status}
        </p>
      </section>
    </main>
  );
}
