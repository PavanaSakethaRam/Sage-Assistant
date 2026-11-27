import { useEffect, useRef, useState } from "react";
import type { PairView, SageApi, Settings } from "../shared/contracts";
import {
  disclosureHash,
  FOCUS_NAMES,
  type CodeDraft,
  type CodeJobView,
  type CodeReceipt,
} from "../shared/coding-contracts";
import { call, message } from "./host";
const running = new Set([
  "context_ready",
  "proposing",
  "review_required",
  "applying",
  "applied_saved",
  "test_review",
  "testing",
]);
const jobLabels: Record<CodeJobView["state"], string> = {
  context_ready: "Context ready",
  proposing: "Preparing proposal",
  review_required: "Review required",
  applying: "Applying reviewed changes",
  applied_saved: "Changes saved",
  applied_unsaved: "Changes not saved",
  needs_review: "Review needed",
  test_review: "Test review required",
  testing: "Tests running",
  completed: "Request completed",
  rejected: "Request rejected",
  cancelled: "Request cancelled",
  failed: "Request failed",
  partial: "Partially applied",
  interrupted: "Interrupted",
  needs_reconciliation: "Outcome needs inspection",
};
const receiptLabels: {
  [S in CodeReceipt["scope"]]: Record<
    Extract<CodeReceipt, { scope: S }>["status"],
    string
  >;
} = {
  "code.create": {
    created: "File created",
    partial: "Creation incomplete",
    needs_reconciliation: "Creation outcome unknown",
  },
  "code.replace": {
    applied_saved: "Replacement saved",
    applied_unsaved: "Replacement not saved",
    needs_review: "Replacement needs review",
    needs_reconciliation: "Replacement outcome unknown",
  },
  "code.test": {
    passed: "Tests passed",
    failed: "Tests failed",
    cancelled: "Test run cancelled",
    changed_during_test: "Files changed during test",
    unknown: "Test outcome unknown",
    termination_unconfirmed: "Test termination unconfirmed",
  },
};
function receiptSummary(receipt: CodeReceipt) {
  if (receipt.scope === "code.test")
    return `focus.test.mjs · ${receiptLabels[receipt.scope][receipt.status]}`;
  const label =
    receipt.scope === "code.create"
      ? receiptLabels[receipt.scope][receipt.status]
      : receiptLabels[receipt.scope][receipt.status];
  return `${receipt.target} · ${label} · Observed hash: ${receipt.observed_hash ?? "not observed"}`;
}
function identity(job: CodeJobView) {
  return `${job.binding.job_id}:${job.binding.revision}:${job.context_hash}:${job.account_generation}`;
}
function matches(pair: PairView, job: CodeJobView) {
  return (
    pair.status === "paired" &&
    pair.pair_id === job.binding.pair_id &&
    pair.window_id === job.binding.window_id &&
    pair.root_id === job.binding.root_id
  );
}
export function Development({ api }: { api: SageApi }) {
  const [pair, setPair] = useState<PairView | null>(null),
    [job, setJob] = useState<CodeJobView | null>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [prompt, setPrompt] = useState(""),
    [hash, setHash] = useState(""),
    [busy, setBusy] = useState(false),
    [sending, setSending] = useState(false),
    [status, setStatus] = useState("Loading editor status"),
    [history, setHistory] = useState<readonly CodeJobView[]>([]),
    [offset, setOffset] = useState<number | null>(0);
  const state = useRef({
    alive: false,
    pair: null as PairView | null,
    job: null as CodeJobView | null,
    epoch: 0,
    prompt: "",
    gesture: 0,
    sendOwner: 0,
    historyOwner: 0,
    cleared: new Set<string>(),
    retired: new Set<string>(),
    buffered: new Map<string, CodeJobView>(),
  });
  function accept(value: CodeJobView) {
    const s = state.current;
    if (!s.alive || s.cleared.has(value.binding.pair_id)) return;
    if (!s.pair) {
      const buffered = s.buffered.get(value.binding.pair_id);
      if (
        !buffered ||
        buffered.binding.job_id !== value.binding.job_id ||
        (value.binding.revision >= buffered.binding.revision &&
          (running.has(buffered.state) || !running.has(value.state)))
      )
        s.buffered.set(value.binding.pair_id, value);
      return;
    }
    if (!matches(s.pair, value) || Date.parse(value.expires_at) <= Date.now())
      return;
    const old = s.job;
    if (
      s.retired.has(identity(value)) ||
      (old &&
        old.binding.job_id === value.binding.job_id &&
        (value.binding.revision < old.binding.revision ||
          (identity(value) === identity(old) &&
            !running.has(old.state) &&
            running.has(value.state))))
    )
      return;
    if (old && identity(old) !== identity(value)) s.retired.add(identity(old));
    s.job = value;
    s.epoch++;
    setJob(value);
  }
  function pairSnapshot(value: PairView | null) {
    const s = state.current;
    if (value && s.cleared.has(value.pair_id)) return;
    if (s.pair?.pair_id !== value?.pair_id) {
      s.job = null;
      s.epoch++;
      s.prompt = "";
      setPrompt("");
      setJob(null);
    }
    s.pair = value;
    setPair(value);
    if (value) {
      const buffered = s.buffered.get(value.pair_id);
      s.buffered.clear();
      if (buffered) accept(buffered);
    }
  }
  useEffect(() => {
    const s = state.current;
    s.alive = true;
    const unsubscribe = api.onProgress((event) => {
      if (!s.alive) return;
      if (event.kind === "coding_status") accept(event.job);
      if (event.kind === "coding_cleared") {
        s.cleared.add(event.pair_id);
        s.buffered.delete(event.pair_id);
        if (s.pair?.pair_id === event.pair_id) {
          s.gesture++;
          pairSnapshot(null);
          setHash("");
          s.sendOwner++;
          setSending(false);
          setBusy(false);
          setStatus("Editor disconnected; disclosure cleared");
        }
      }
    });
    const gesture = ++s.gesture;
    void Promise.all([
      call(api, "settings.get", {}),
      call(api, "editor.status", {}),
    ]).then(
      ([selected, paired]) => {
        if (!s.alive || gesture !== s.gesture) return;
        setSettings(selected);
        pairSnapshot(paired);
        setStatus(
          paired
            ? "Editor status loaded"
            : "No editor paired. Pair explicitly, then refresh after connecting VS Code.",
        );
      },
      (error) => {
        if (s.alive && gesture === s.gesture)
          setStatus(`Development unavailable: ${message(error)}`);
      },
    );
    return () => {
      s.alive = false;
      s.epoch++;
      s.gesture++;
      s.sendOwner++;
      s.buffered.clear();
      s.prompt = "";
      s.job = null;
      s.pair = null;
      unsubscribe();
    };
    // This subscription owns one API lifetime; all callbacks fence through the same ref.
  }, [api]);
  useEffect(() => {
    setHash("");
    if (!job || !pair || !matches(pair, job) || job.state !== "context_ready")
      return;
    const s = state.current,
      epoch = s.epoch,
      literal = prompt;
    const draft: CodeDraft = {
      job_id: job.binding.job_id,
      revision: job.binding.revision,
      account_generation: job.account_generation,
      user_text: literal,
      backend: "copilot",
      model: job.model,
    };
    void disclosureHash(job, draft).then(
      (value) => {
        if (s.alive && s.epoch === epoch && s.prompt === literal)
          setHash(value);
      },
      () => {},
    );
  }, [job, pair, prompt]);
  useEffect(() => {
    if (!job) return;
    const remaining = Date.parse(job.expires_at) - Date.now();
    const timer = setTimeout(
      () => {
        const s = state.current;
        if (s.job && identity(s.job) === identity(job)) {
          s.job = null;
          s.epoch++;
          s.prompt = "";
          setPrompt("");
          setJob(null);
          setHash("");
          setStatus(
            "Selected context expired. Select fresh context in VS Code.",
          );
        }
      },
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [job]);
  useEffect(() => {
    if (!prompt) return;
    const timer = setTimeout(() => {
      const s = state.current;
      s.prompt = "";
      s.epoch++;
      setPrompt("");
      setHash("");
    }, 1_800_000);
    return () => clearTimeout(timer);
  }, [prompt]);
  async function editor(
    method:
      "editor.pair" | "editor.status" | "editor.confirm" | "editor.disconnect",
  ) {
    const s = state.current,
      gesture = ++s.gesture;
    setBusy(true);
    if (method === "editor.pair" || method === "editor.disconnect")
      pairSnapshot(null);
    if (method !== "editor.status") {
      s.epoch++;
      setHash("");
    }
    try {
      const value = await call(api, method, {});
      if (s.alive && s.gesture === gesture) {
        pairSnapshot(value);
        setStatus(
          value
            ? "Compare this exact window, folder and challenge in both apps before sharing."
            : "No editor paired; pairing may be cancelled, expired or unavailable.",
        );
      }
    } catch (error) {
      if (s.alive && s.gesture === gesture)
        setStatus(`Editor unavailable: ${message(error)}`);
    } finally {
      if (s.alive && s.gesture === gesture) setBusy(false);
    }
  }
  async function send() {
    const s = state.current;
    if (
      !job ||
      !hash ||
      !pair ||
      !matches(pair, job) ||
      s.prompt !== prompt ||
      Date.now() >= Date.parse(job.expires_at)
    )
      return;
    const snapshot = job,
      literal = prompt,
      epoch = s.epoch,
      owner = ++s.sendOwner;
    const draft: CodeDraft = {
      job_id: snapshot.binding.job_id,
      revision: snapshot.binding.revision,
      account_generation: snapshot.account_generation,
      user_text: literal,
      backend: "copilot",
      model: snapshot.model,
    };
    setSending(true);
    setStatus("Sending disclosed request…");
    try {
      const value = await call(api, "coding.start", {
        ...draft,
        disclosure_hash: hash,
      });
      if (s.alive && s.epoch === epoch && s.prompt === literal) {
        accept(value);
        setStatus(
          "Request accepted. Proposal review and all file/test decisions stay in VS Code.",
        );
      }
    } catch (error) {
      if (s.alive && s.epoch === epoch && s.prompt === literal)
        setStatus(`Request failed: ${message(error)}`);
    } finally {
      if (s.alive && s.sendOwner === owner) setSending(false);
    }
  }
  async function cancel() {
    const s = state.current;
    if (!job) return;
    const current = identity(job),
      epoch = ++s.epoch;
    setHash("");
    try {
      const value = await call(api, "coding.cancel", {
        job_id: job.binding.job_id,
      });
      if (
        s.alive &&
        s.epoch === epoch &&
        s.job &&
        identity(s.job) === current
      ) {
        accept(value);
        setStatus("Cancellation recorded; inspect observed effects below.");
      }
    } catch (error) {
      if (s.alive && s.epoch === epoch)
        setStatus(`Cancellation unavailable: ${message(error)}`);
    }
  }
  async function loadHistory(pageOffset = offset ?? 0) {
    const s = state.current,
      gesture = s.gesture,
      owner = ++s.historyOwner;
    try {
      const page = await call(api, "coding.list", {
        limit: 20,
        offset: pageOffset,
      });
      if (s.alive && s.gesture === gesture && s.historyOwner === owner) {
        setHistory(page.items);
        setOffset(page.next_offset);
        setStatus("Source-free development history loaded");
      }
    } catch (error) {
      if (s.alive && s.gesture === gesture && s.historyOwner === owner)
        setStatus(`History unavailable: ${message(error)}`);
    }
  }
  const enabled =
    settings?.ai_mode === "assistant" && settings.coding_backend === "copilot";
  return (
    <section aria-labelledby="development-heading">
      <h2 id="development-heading">Development</h2>
      <p>
        Pair one trusted local single-folder VS Code window. Pairing and status
        do not read source or run a model.
      </p>
      <div className="actions">
        <button disabled={busy} onClick={() => void editor("editor.pair")}>
          Pair VS Code
        </button>
        <button disabled={busy} onClick={() => void editor("editor.status")}>
          Refresh editor status
        </button>
        <button
          disabled={busy || !pair}
          onClick={() => void editor("editor.disconnect")}
        >
          Disconnect editor
        </button>
      </div>
      {pair && (
        <article aria-label="Paired destination">
          <p>{pair.root_uri}</p>
          <p>
            Window: {pair.window_id} · Root: {pair.root_id}
          </p>
          <p>
            Challenge: {pair.challenge} · {pair.status}
          </p>
          <button
            disabled={busy || pair.status === "paired"}
            onClick={() => void editor("editor.confirm")}
          >
            Confirm window and folder
          </button>
          <p>
            Confirmation requires a native Sage choice and confirmation in VS
            Code. Select and preview source there before sharing locally.
          </p>
        </article>
      )}
      {!enabled && (
        <p>
          {settings?.ai_mode === "local"
            ? "Local AI only: cloud coding is unavailable."
            : "Coding is disabled or unavailable. Select Copilot coding separately in Setup."}{" "}
          Local notes remain available.
        </p>
      )}
      {job && (
        <article aria-label="Selected disclosure">
          <h3>Selected disclosure</h3>
          <p>
            Selected files: {job.file_count} · {job.mode}
          </p>
          <p>
            Manifest: {job.manifest.join(", ") || "empty folder (creation)"}
            {job.target ? ` · Replace only ${job.target}` : ""}
          </p>
          {job.mode === "create_focus_project" && (
            <p>Proposed outputs: {FOCUS_NAMES.join(", ")}</p>
          )}
          <p>
            Source: {job.source_codepoints} · Diagnostics:{" "}
            {job.diagnostics_codepoints} · Provider-visible metadata:{" "}
            {job.metadata_codepoints} code points
          </p>
          <p>Context hash: {job.context_hash}</p>
          <ul>
            {job.hashes.map((item) => (
              <li key={item.name}>
                {item.name} · source {item.source_hash ?? "none"} · proposed{" "}
                {item.proposed_hash ?? "none"} · observed{" "}
                {item.observed_hash ?? "none"}
              </li>
            ))}
          </ul>
          <p>
            Provider: GitHub Copilot · Account: {job.account ?? "none selected"}{" "}
            · Model: {job.model ?? "Provider default (exact model unknown)"}
          </p>
          <p>
            Cloud destination: {job.destination} · Account generation:{" "}
            {job.account_generation}
          </p>
          <p>
            Original context expiry: {job.expires_at}. Source preview and file
            selection stay in VS Code.
          </p>
          <p>
            Job status: {jobLabels[job.state]}
            {job.diagnostic ? ` · ${job.diagnostic}` : ""}
          </p>
          {job.state === "applied_saved" && (
            <p>
              Files created or saved. Tests have not run; separate test review
              remains in VS Code until the original context expires or is
              dismissed there.
            </p>
          )}
          {job.state === "applied_unsaved" && (
            <p>
              Replacement remains unsaved. Inspect it in VS Code; tests have not
              run.
            </p>
          )}
          {job.cancel_requested && running.has(job.state) && (
            <p>Cancellation requested; waiting for effect settlement.</p>
          )}
          {(running.has(job.state) || sending) && (
            <button onClick={() => void cancel()}>Cancel request</button>
          )}
          <p>
            Observed receipts only; proposal text does not prove code ran.
            Partial, unknown and unconfirmed test termination outcomes need
            inspection in VS Code.
          </p>
          <ul aria-label="Observed development receipts">
            {job.receipts.map((receipt, i) => (
              <li key={i}>
                {receiptSummary(receipt)}
                <details>
                  <summary>Technical receipt details</summary>
                  <pre>{JSON.stringify(receipt, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        </article>
      )}
      <label htmlFor="development-prompt">Development prompt</label>
      <textarea
        id="development-prompt"
        value={prompt}
        aria-describedby="development-budget development-send"
        onChange={(event) => {
          const value = event.target.value;
          state.current.prompt = value;
          state.current.epoch++;
          setHash("");
          setPrompt(value);
        }}
      />
      <p id="development-budget">
        {[...prompt].length} / 32000 code points. Over-budget input is rejected.
      </p>
      {hash && <p>Disclosure hash: {hash}</p>}
      <p id="development-send">
        Send request transmits the literal prompt and the selected source,
        diagnostics and metadata above to the displayed cloud destination and
        may consume account quota. Pairing and local sharing alone do not send
        to a model. Apply, save and test require separate VS Code review.
      </p>
      <button
        disabled={
          busy ||
          sending ||
          !enabled ||
          !pair ||
          !job ||
          job.account === null ||
          job.state !== "context_ready" ||
          !hash
        }
        aria-describedby="development-send"
        onClick={() => void send()}
      >
        Send request
      </button>
      <div className="actions">
        <button
          onClick={() => {
            void loadHistory(0);
          }}
        >
          Load development history
        </button>
        {offset !== null && offset > 0 && (
          <button onClick={() => void loadHistory()}>
            Next development history
          </button>
        )}
      </div>
      <ul aria-label="Development history">
        {history.map((item) => (
          <li key={identity(item)}>
            {item.binding.job_id} · {jobLabels[item.state]} ·{" "}
            {item.receipts.map(receiptSummary).join(", ") ||
              "No observed receipts"}
          </li>
        ))}
      </ul>
      <p role="status" aria-label="Development status">
        {status}
      </p>
    </section>
  );
}
