import { useEffect, useRef, useState } from "react";
import type { Page, NoteSummary, Results, SageApi } from "../shared/contracts";
import { call, message, validRequest } from "./host";
import { SafeMarkdown } from "./SafeMarkdown";
export function Notes({
  api,
  refresh = 0,
}: {
  api: SageApi;
  refresh?: number;
}) {
  const [query, setQuery] = useState(""),
    [searched, setSearched] = useState(""),
    [page, setPage] = useState<Page<NoteSummary>>({
      items: [],
      next_offset: null,
    }),
    [note, setNote] = useState<Results["notes.get"] | null>(null),
    [status, setStatus] = useState(""),
    [offset, setOffset] = useState(0);
  const listGeneration = useRef(0),
    detailGeneration = useRef(0);
  useEffect(() => {
    const generation = ++listGeneration.current;
    setStatus("Loading saved notes");
    void (
      searched
        ? call(api, "notes.search", { query: searched, limit: 20, offset })
        : call(api, "notes.list", { limit: 20, offset })
    ).then(
      (p) => {
        if (generation === listGeneration.current) {
          setPage(p);
          setStatus("");
        }
      },
      (e) => {
        if (generation === listGeneration.current)
          setStatus(`Notes unavailable: ${message(e)}`);
      },
    );
    return () => {
      listGeneration.current++;
    };
  }, [api, searched, offset, refresh]);
  useEffect(
    () => () => {
      detailGeneration.current++;
    },
    [],
  );
  async function open(note_id: string) {
    const generation = ++detailGeneration.current;
    setNote(null);
    try {
      const n = await call(api, "notes.get", { note_id });
      if (generation === detailGeneration.current) {
        setNote(n);
        setStatus("");
      }
    } catch (e) {
      if (generation === detailGeneration.current)
        setStatus(`Note unavailable: ${message(e)}`);
    }
  }
  return (
    <section aria-labelledby="notes-heading">
      <h2 id="notes-heading">Saved notes</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          detailGeneration.current++;
          setNote(null);
          setOffset(0);
          setSearched(query);
        }}
      >
        <label>
          Search saved notes
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button disabled={!validRequest("notes.search", { query })}>
          Search
        </button>
      </form>
      <ul>
        {page.items.map((n) => (
          <li key={n.id}>
            <button onClick={() => void open(n.id)}>{n.title}</button>
            <small> {n.updated_at}</small>
          </li>
        ))}
      </ul>
      {page.items.length === 0 && <p>No saved notes in this page.</p>}
      <div className="actions">
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous notes
        </button>
        <button
          disabled={page.next_offset === null}
          onClick={() => setOffset(page.next_offset!)}
        >
          Next notes
        </button>
      </div>
      {note && (
        <article aria-label="Saved note details">
          <h3>{note.title}</h3>
          <pre aria-label="Saved note literal body">{note.body}</pre>
          <SafeMarkdown text={note.body} api={api} />
        </article>
      )}
      <p role="status" aria-label="Saved notes status">
        {status}
      </p>
    </section>
  );
}
