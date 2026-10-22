import { useEffect, useRef, useState } from "react";
import type {
  NoteContent,
  Proposal,
  SageApi,
  Results,
} from "../shared/contracts";
import { parseNoteContent } from "../shared/contracts";
import { call, message } from "./host";
import { SafeMarkdown } from "./SafeMarkdown";
export function NoteReview({
  api,
  proposal: initial = null,
  reviewRequired = false,
  onChange = () => {},
  onSaved = () => {},
}: {
  api: SageApi;
  proposal?: Proposal | null;
  reviewRequired?: boolean;
  onChange?: () => void;
  onSaved?: () => void;
}) {
  const [proposal, setProposal] = useState(initial),
    [content, setContent] = useState<NoteContent>(
      initial?.arguments ?? { title: "", body: "" },
    ),
    [editing, setEditing] = useState(!initial),
    [renew, setRenew] = useState(reviewRequired),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [saved, setSaved] = useState<Results["notes.get"] | null>(null),
    [ended, setEnded] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  let valid = true;
  try {
    parseNoteContent(content);
  } catch {
    valid = false;
  }
  async function review() {
    setBusy(true);
    try {
      const p = proposal
        ? await call(api, "notes.revise", {
            ...content,
            proposal_id: proposal.id,
            revision: proposal.revision,
          })
        : await call(api, "notes.propose", content);
      if (alive.current) {
        setProposal(p);
        setContent(p.arguments);
        setEditing(false);
        setRenew(false);
        setStatus("Pending review");
      }
    } catch (e) {
      if (alive.current)
        setStatus(`Review failed: ${message(e)}. Your edits are retained.`);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function decide(decision: "save" | "cancel") {
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await call(api, "notes.decide", {
        proposal_id: proposal.id,
        revision: proposal.revision,
        decision,
      });
      if (!alive.current) return;
      setStatus(
        `${result.status}${result.diagnostic ? ` — ${result.diagnostic}` : ""}`,
      );
      if (result.status === "cancelled") {
        setContent({ title: "", body: "" });
        setProposal(null);
        setEnded(true);
        setStatus("Draft cancelled");
      } else if (result.status === "succeeded" && result.note_id) {
        setEnded(true);
        setProposal(null);
        setContent({ title: "", body: "" });
        onSaved();
        try {
          const note = await call(api, "notes.get", {
            note_id: result.note_id,
          });
          if (alive.current) {
            setSaved(note);
            setStatus("Saved note");
          }
        } catch (e) {
          if (alive.current)
            setStatus(
              `Saved as ${result.note_id}; loading saved note failed: ${message(e)}`,
            );
        }
      } else setRenew(true);
    } catch (e) {
      if (alive.current) {
        setStatus(
          `Decision failed: ${message(e)}. Review again before retrying Save.`,
        );
        setRenew(true);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section aria-labelledby="review-heading">
      <h2 id="review-heading">Note review</h2>
      {!ended && (
        <>
          {editing ? (
            <>
              <label>
                Note title
                <input
                  aria-label="Note title"
                  value={content.title}
                  onChange={(e) => {
                    setContent({ ...content, title: e.target.value });
                    onChange();
                  }}
                  disabled={busy}
                />
              </label>
              <p>{[...content.title].length} / 200 code points</p>
              <label>
                Note body
                <textarea
                  aria-label="Note body"
                  value={content.body}
                  onChange={(e) => {
                    setContent({ ...content, body: e.target.value });
                    onChange();
                  }}
                  disabled={busy}
                />
              </label>
              <p>{[...content.body].length} / 100,000 code points</p>
              {!valid && (
                <p>
                  Enter nonblank title/body within the code point limits,
                  without invalid controls.
                </p>
              )}
              <button disabled={!valid || busy} onClick={() => void review()}>
                Review note
              </button>
            </>
          ) : (
            <>
              <p>
                Pending draft · revision {proposal?.revision}. Save approves
                this exact revision. Review expires after five minutes or
                restart.
              </p>
              <h3>Literal title</h3>
              <pre aria-label="Literal note title">{content.title}</pre>
              <h3>Literal body</h3>
              <pre aria-label="Literal note body">{content.body}</pre>
              <SafeMarkdown text={content.body} api={api} />
              {renew && (
                <>
                  <p>
                    Fresh review required. Review again issues a new revision;
                    stale Save never renews approval.
                  </p>
                  <button disabled={busy} onClick={() => void review()}>
                    Review again
                  </button>
                </>
              )}
              <div className="actions">
                <button
                  disabled={busy || renew}
                  onClick={() => void decide("save")}
                >
                  Save note
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditing(true);
                    onChange();
                  }}
                >
                  Edit draft
                </button>
              </div>
            </>
          )}
          {!proposal && (
            <button
              disabled={busy}
              onClick={() => {
                setContent({ title: "", body: "" });
                setEnded(true);
                onChange();
                setStatus("Local edits discarded");
              }}
            >
              Discard local edits
            </button>
          )}
          {proposal && (
            <button disabled={busy} onClick={() => void decide("cancel")}>
              Cancel draft
            </button>
          )}
        </>
      )}
      {saved && (
        <>
          <h3>Persisted title</h3>
          <pre aria-label="Saved title">{saved.title}</pre>
          <pre aria-label="Saved body">{saved.body}</pre>
        </>
      )}
      <p role="status" aria-label="Note review status">
        {busy ? "Pending…" : status}
      </p>
    </section>
  );
}
