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
    [status, setStatus] = useState("");
  const generation = useRef(0),
    taskGeneration = useRef(0),
    alive = useRef(true),
    cancelledTasks = useRef(new Map<string, ActionResult>());
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
              cancelledTasks.current.has(item.id)
                ? { ...item, status: "cancelled" }
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
  function cancelledTask(value: Results["tasks.get"]): Results["tasks.get"] {
    const outcome = cancelledTasks.current.get(value.id);
    return outcome
      ? {
          ...value,
          status: "cancelled",
          proposal: null,
          review_required: false,
          outcome,
        }
      : value;
  }
  function purgeCancelledTask(task_id: string, outcome: ActionResult) {
    if (!alive.current) return;
    // The acknowledgement fences this identity, independently of selected detail.
    cancelledTasks.current.set(task_id, outcome);
    setDraft((current) =>
      current?.proposal?.task_id === task_id ? null : current,
    );
    setTask((current) =>
      current?.id === task_id ? cancelledTask(current) : current,
    );
    setTasks((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === task_id ? { ...item, status: "cancelled" } : item,
      ),
    }));
    setRefresh((v) => v + 1);
  }
  function openDraft(proposal: Proposal | null, reviewRequired = false) {
    if (proposal && cancelledTasks.current.has(proposal.task_id)) return;
    dirty();
    setDraft({ proposal, reviewRequired, key: generation.current });
  }
  async function getTask(task_id: string) {
    const token = ++taskGeneration.current;
    try {
      const t = await call(api, "tasks.get", { task_id });
      if (token === taskGeneration.current) {
        setTask(cancelledTask(t));
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
      if (result.status === "cancelled") purgeCancelledTask(task_id, result);
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
              onSaved={() => setRefresh((v) => v + 1)}
              onProposal={(proposal) => {
                setDraft((current) =>
                  current?.key === draft.key
                    ? cancelledTasks.current.has(proposal.task_id)
                      ? null
                      : { ...current, proposal }
                    : current,
                );
              }}
              onOutcome={(result, identity) => {
                if (result.status === "cancelled")
                  purgeCancelledTask(identity.task_id, result);
              }}
            />
          )}
          <Notes api={api} refresh={refresh} />
        </div>
      </div>
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
