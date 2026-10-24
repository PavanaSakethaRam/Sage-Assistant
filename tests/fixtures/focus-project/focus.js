/* A classic file:// script and a pure clock-injected factory for Node tests. */
(() => {
  function createFocus(clock = () => performance.now()) {
    let name = "Focus session",
      elapsed = 0,
      started = null,
      completed = 0,
      total = 0;
    const current = () =>
      elapsed + (started === null ? 0 : Math.max(0, clock() - started));
    return Object.freeze({
      state: () => ({
        name,
        elapsed: current(),
        running: started !== null,
        completed,
        total,
      }),
      name(value) {
        name = String(value).trim() || "Focus session";
      },
      start() {
        if (started === null) started = clock();
      },
      pause() {
        elapsed = current();
        started = null;
      },
      reset() {
        elapsed = 0;
        started = null;
      },
      finish() {
        const duration = current();
        if (duration > 0) {
          completed++;
          total += duration;
        }
        elapsed = 0;
        started = null;
      },
    });
  }
  globalThis.createFocus = createFocus;
  if (typeof document === "undefined") return;
  const tracker = createFocus(),
    get = (id) => document.getElementById(id);
  const format = (ms) =>
    `${Math.floor(ms / 60000)
      .toString()
      .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
      .toString()
      .padStart(2, "0")}`;
  function render() {
    const state = tracker.state();
    get("elapsed").textContent = format(state.elapsed);
    get("completed").textContent = String(state.completed);
    get("total").textContent = format(state.total);
    get("status").textContent =
      `${state.name} · ${state.running ? "Running" : "Paused"}`;
  }
  get("session-name").addEventListener("input", (event) => {
    tracker.name(event.target.value);
    render();
  });
  for (const action of ["start", "pause", "reset", "finish"])
    get(action).addEventListener("click", () => {
      tracker[action]();
      render();
    });
  render();
  setInterval(render, 100);
})();
