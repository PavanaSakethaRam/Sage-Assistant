// Summarize the complete synthetic core stderr stream without retaining its content.
const markers = {
  hasTraceback: Buffer.from("Traceback"),
  hasBody: Buffer.from("Body"),
  hasSecret: Buffer.from("SYNTHETIC_SECRET"),
};
const codes = new Set([
  "core_started",
  "core_stopped",
  "startup_failed",
  "transport_failed",
  "invalid_frame",
]);
const maxTail =
  Math.max(...Object.values(markers).map((marker) => marker.length)) - 1;

export function createStderrSummary() {
  const found = { hasTraceback: false, hasBody: false, hasSecret: false };
  const diagnostics = [];
  let tail = Buffer.alloc(0);
  let line = "";
  let lineOverflow = false;
  let finalized = false;

  return {
    push(part) {
      const combined = Buffer.concat([tail, part]);
      for (const [key, marker] of Object.entries(markers)) {
        if (combined.includes(marker)) found[key] = true;
      }
      tail = Buffer.from(
        combined.subarray(Math.max(0, combined.length - maxTail)),
      );

      for (const byte of part) {
        if (byte === 10) {
          if (
            !lineOverflow &&
            diagnostics.length < 32 &&
            codes.has(line.trimEnd())
          )
            diagnostics.push(line.trimEnd());
          line = "";
          lineOverflow = false;
        } else if (!lineOverflow) {
          if (line.length < 32) line += String.fromCharCode(byte);
          else lineOverflow = true;
        }
      }
    },
    result() {
      if (
        !finalized &&
        !lineOverflow &&
        diagnostics.length < 32 &&
        codes.has(line.trimEnd())
      )
        diagnostics.push(line.trimEnd());
      finalized = true;
      return { ...found, diagnostics: [...diagnostics] };
    },
  };
}
