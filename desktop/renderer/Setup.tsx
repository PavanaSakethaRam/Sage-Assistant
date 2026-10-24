import { useEffect, useRef, useState } from "react";
import type { Settings, SageApi, Readiness } from "../shared/contracts";
import { call, message } from "./host";
export function Setup({
  api,
  onSettings,
  onBusy,
}: {
  api: SageApi;
  onSettings: (s: Settings | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [items, setItems] = useState<Readiness[]>([]),
    [busy, setBusy] = useState(true),
    [status, setStatus] = useState("Loading settings");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setBusy(true);
    onBusy(true);
    void Promise.all([
      call(api, "settings.get", {}),
      call(api, "readiness.list", {}),
    ]).then(
      ([s, r]) => {
        if (alive.current) {
          setSettings(s);
          onSettings(s);
          setItems(r.items);
          setStatus("");
          setBusy(false);
          onBusy(false);
        }
      },
      (e) => {
        if (alive.current) {
          setStatus(`Setup unavailable: ${message(e)}`);
          setBusy(false);
          onBusy(false);
        }
      },
    );
    return () => {
      alive.current = false;
    };
  }, [api, onSettings, onBusy]);
  async function refreshReadiness() {
    try {
      const r = await call(api, "readiness.list", {});
      if (alive.current) setItems(r.items);
    } catch (e) {
      if (alive.current) {
        setItems([]);
        setStatus(
          (previous) => `${previous}; readiness unavailable: ${message(e)}`,
        );
      }
    }
  }
  async function reload() {
    setBusy(true);
    onBusy(true);
    setItems([]);
    try {
      const s = await call(api, "settings.get", {});
      if (alive.current) {
        setSettings(s);
        onSettings(s);
        setStatus("Settings loaded");
      }
    } catch (e) {
      if (alive.current) setStatus(`Setup unavailable: ${message(e)}`);
    } finally {
      if (alive.current) {
        await refreshReadiness();
        if (alive.current) {
          setBusy(false);
          onBusy(false);
        }
      }
    }
  }
  async function update(ai_mode: Settings["ai_mode"]) {
    setBusy(true);
    onBusy(true);
    setItems([]);
    setStatus("Changing mode…");
    try {
      const s = await call(api, "settings.update", {
        ai_mode,
        reasoning_backend:
          ai_mode === "assistant"
            ? "copilot"
            : ai_mode === "api"
              ? "api"
              : null,
      });
      if (alive.current) {
        setSettings(s);
        onSettings(s);
        setStatus("Mode saved");
      }
    } catch (e) {
      if (alive.current) {
        setStatus(`Mode change failed: ${message(e)}`);
        try {
          const s = await call(api, "settings.get", {});
          if (alive.current) {
            setSettings(s);
            onSettings(s);
          }
        } catch {
          if (alive.current) {
            setSettings(null);
            onSettings(null);
            setStatus(
              "Mode change failed; actual mode unknown. Retry loading settings.",
            );
          }
        }
      }
    } finally {
      if (alive.current) {
        await refreshReadiness();
        if (alive.current) {
          setBusy(false);
          onBusy(false);
        }
      }
    }
  }
  async function updateCoding(coding_backend: "none" | "copilot") {
    setBusy(true);
    onBusy(true);
    try {
      const value = await call(api, "settings.update", {
        coding_backend,
        coding_model: null,
      });
      if (alive.current) {
        setSettings(value);
        onSettings(value);
        setStatus("Coding preference saved");
      }
    } catch (error) {
      if (alive.current) {
        setStatus(`Coding preference failed: ${message(error)}`);
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  async function account(
    method: "copilot.chooseAccount" | "copilot.disconnect" | "connection.test",
  ) {
    setBusy(true);
    onBusy(true);
    setItems([]);
    try {
      const r = await call(api, method, {});
      if (alive.current) {
        setStatus(
          method === "copilot.chooseAccount" && r.status === "selected"
            ? "Account selected; this is not model readiness. Test explicitly."
            : `Connection: ${r.status}${"explanation" in r ? ` — ${r.explanation}` : ""}`,
        );
      }
    } catch (e) {
      if (alive.current) setStatus(`Connection failed: ${message(e)}`);
    } finally {
      if (alive.current) {
        await refreshReadiness();
        if (alive.current) {
          setBusy(false);
          onBusy(false);
        }
      }
    }
  }
  return (
    <section aria-labelledby="setup-heading">
      <h2 id="setup-heading">Setup</h2>
      <p>Actual mode: {settings?.ai_mode ?? "unknown"}</p>
      <fieldset disabled={busy || !settings}>
        <legend>AI mode</legend>
        {(
          [
            ["local", "Local AI only"],
            ["assistant", "Connect an assistant"],
            ["api", "Use an API key"],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="mode"
              checked={settings?.ai_mode === value}
              onChange={() => void update(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {settings?.ai_mode === "local" && (
        <p>
          Local inference is unavailable. Local note controls work without a
          model.
        </p>
      )}
      {settings?.ai_mode === "api" && (
        <p>
          API adapters are unavailable in this foundation. No API key is
          collected.
        </p>
      )}
      {settings?.ai_mode === "assistant" && (
        <>
          <label>
            Assistant
            <select
              aria-label="Assistant"
              disabled={busy}
              value="copilot"
              onChange={() => {}}
            >
              <option value="copilot">GitHub Copilot</option>
              <option disabled>Codex — unavailable</option>
              <option disabled>OpenCode — unavailable</option>
              <option disabled>Claude — unavailable</option>
            </select>
          </label>
          <p>
            VSCode sign-in does not establish SDK account readiness. Account
            selection uses a native host picker.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() => void account("copilot.chooseAccount")}
            >
              Choose Copilot account
            </button>
            <button
              disabled={busy}
              onClick={() => void account("copilot.disconnect")}
            >
              Disconnect account
            </button>
          </div>
          <p id="quota">
            Test connection sends a fixed synthetic prompt to GitHub Copilot
            cloud and may consume account quota. Selection and discovery do not
            run a model.
          </p>
          <button
            disabled={busy}
            aria-describedby="quota"
            onClick={() => void account("connection.test")}
          >
            Test connection
          </button>
        </>
      )}
      <fieldset
        disabled={busy || !settings || settings.ai_mode !== "assistant"}
      >
        <legend>Coding preference</legend>
        <label>
          Coding provider
          <select
            aria-label="Coding provider"
            value={settings?.coding_backend ?? "none"}
            onChange={(event) =>
              void updateCoding(event.target.value as "none" | "copilot")
            }
          >
            <option value="none">Disabled</option>
            <option value="copilot">GitHub Copilot</option>
          </select>
        </label>
        <p>
          Separate from conversation. Model:{" "}
          {settings?.coding_model ?? "Provider default (exact model unknown)"}.
          Changing this preference disconnects the editor; select fresh context
          afterward.
        </p>
      </fieldset>
      <ul aria-label="Provider prerequisites">
        {items.map((item) => (
          <li key={item.provider}>
            <strong>
              {item.provider}: {item.status}
            </strong>{" "}
            — {item.explanation}
            {item.diagnostic && (
              <span>
                {" "}
                Stage: {item.diagnostic.stage}; category:{" "}
                {item.diagnostic.category}.
              </span>
            )}
            {item.destination && <span> Destination: {item.destination}.</span>}
            {item.evidence.length > 0 && (
              <span> Evidence: {item.evidence.join(", ")}.</span>
            )}
          </li>
        ))}
      </ul>
      <p role="status" aria-label="Setup status">
        {status}
      </p>
      {!settings && !busy && (
        <button onClick={() => void reload()}>Reload settings</button>
      )}
    </section>
  );
}
