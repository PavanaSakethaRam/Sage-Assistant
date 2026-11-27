/** Bounded direct-child checks for the two fixed offline frozen-core switches. */
import { spawn } from "node:child_process";

const MAX_BODY = 16384;
const MAX_FRAME = MAX_BODY + 4;

function invalidFrame() {
  return new TypeError("Invalid fixed probe frame");
}

export function decodeFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame.length > MAX_FRAME)
    throw invalidFrame();
  const size = frame.readUInt32BE(0);
  if (size < 1 || size > MAX_BODY || frame.length !== size + 4)
    throw invalidFrame();
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      frame.subarray(4),
    );
    value = JSON.parse(text);
    // JSON.parse discards duplicate keys. Inspect tokens in the already-valid JSON,
    // including escaped key spellings, while keeping one key set per object.
    const stack = [];
    for (const token of text.matchAll(
      /"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/gu,
    )) {
      const word = token[0];
      const top = stack.at(-1);
      if (word === "{") stack.push({ keys: new Set(), key: true });
      else if (word === "[") stack.push(null);
      else if (word === "}" || word === "]") stack.pop();
      else if (word === "," && top) top.key = true;
      else if (word.startsWith('"') && top?.key) {
        const key = JSON.parse(word);
        if (top.keys.has(key)) throw invalidFrame();
        top.keys.add(key);
        top.key = false;
      }
    }
    function check(item, depth) {
      if (depth > 32 || (typeof item === "number" && !Number.isFinite(item)))
        throw invalidFrame();
      if (typeof item === "string" && /[\uD800-\uDFFF]/u.test(item))
        throw invalidFrame();
      if (item && typeof item === "object") {
        for (const [key, child] of Object.entries(item)) {
          if (/[\uD800-\uDFFF]/u.test(key)) throw invalidFrame();
          check(child, depth + 1);
        }
      }
    }
    check(value, 0);
  } catch {
    throw invalidFrame();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidFrame();
  return value;
}

function keys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateMetadata(value) {
  const trust = value?.trust;
  const store = trust?.store;
  const paths = trust?.default_paths;
  const overrides = value?.environment_overrides;
  const valid =
    keys(value, [
      "schema",
      "python",
      "openssl",
      "sqlite",
      "sdk",
      "certifi",
      "frozen",
      "ssl_module",
      "bundle",
      "trust",
      "environment_overrides",
    ]) &&
    value.schema === 1 &&
    value.frozen === true &&
    value.sdk === "1.0.25" &&
    value.certifi === "2026.10.19" &&
    nonempty(value.python) &&
    value.python.split(/\s+/u)[0] === "3.13.17" &&
    nonempty(value.openssl) &&
    nonempty(value.sqlite) &&
    nonempty(value.bundle) &&
    nonempty(value.ssl_module) &&
    value.ssl_module !== "unavailable" &&
    keys(trust, [
      "verify_mode",
      "check_hostname",
      "verify_flags",
      "store",
      "default_paths",
      "cafile_exists",
      "capath_exists",
    ]) &&
    trust.verify_mode === 2 &&
    trust.check_hostname === true &&
    Number.isSafeInteger(trust.verify_flags) &&
    typeof trust.cafile_exists === "boolean" &&
    typeof trust.capath_exists === "boolean" &&
    keys(store, ["x509", "x509_ca", "crl"]) &&
    Object.values(store).every(count) &&
    keys(paths, [
      "cafile",
      "capath",
      "openssl_cafile_env",
      "openssl_cafile",
      "openssl_capath_env",
      "openssl_capath",
    ]) &&
    [paths.cafile, paths.capath].every(
      (path) => path === null || typeof path === "string",
    ) &&
    [
      paths.openssl_cafile_env,
      paths.openssl_cafile,
      paths.openssl_capath_env,
      paths.openssl_capath,
    ].every(nonempty) &&
    keys(overrides, [
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "SSLKEYLOGFILE",
      "HTTPS_PROXY",
      "ALL_PROXY",
    ]) &&
    Object.values(overrides).every((flag) => flag === false);
  if (!valid) throw new TypeError("Invalid metadata probe");
  return value;
}

export function validateSdk(value) {
  if (
    !keys(value, [
      "schema",
      "status",
      "stage",
      "category",
      "sdk",
      "python",
      "frozen",
    ]) ||
    value.schema !== 1 ||
    value.status !== "pass" ||
    value.stage !== "complete" ||
    value.category !== "none" ||
    value.sdk !== "1.0.25" ||
    value.python !== "3.13.17" ||
    value.frozen !== true
  )
    throw new TypeError("Invalid SDK probe");
  return value;
}

const sdkStages = ["guard", "sdk_import", "sdk_construct"];
const sdkCategories = [
  "dependency_error",
  "contract_error",
  "io_error",
  "unexpected_error",
  "blocked_network",
  "blocked_process",
  "blocked_storage",
  "blocked_native",
  "blocked_output",
];

function sdkFailureDiagnostic(frame) {
  try {
    const value = decodeFrame(frame);
    if (
      keys(value, [
        "schema",
        "status",
        "stage",
        "category",
        "sdk",
        "python",
        "frozen",
      ]) &&
      value.schema === 1 &&
      value.status === "fail" &&
      sdkStages.includes(value.stage) &&
      sdkCategories.includes(value.category) &&
      ["1.0.25", "unavailable"].includes(value.sdk) &&
      typeof value.python === "string" &&
      /^3\.13\.[0-9]{1,3}$/u.test(value.python) &&
      typeof value.frozen === "boolean"
    )
      return `SDK probe ${value.stage}/${value.category}`;
  } catch {
    /* malformed output remains a generic failure */
  }
  return undefined;
}

export async function runProbe(
  executable,
  option,
  root,
  env,
  { spawnProcess = spawn, timeoutMs = 20000 } = {},
) {
  if (option !== "--self-check" && option !== "--sdk-self-check")
    throw new TypeError("Invalid fixed probe option");
  const label =
    option === "--self-check" ? "Metadata probe failed" : "SDK probe failed";
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, [option], {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      reject(new Error(label));
      return;
    }
    let failed = false;
    let finished = false;
    let total = 0;
    let chunks = [];
    let escalation;
    let closeLimit;
    const clear = () => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      clearTimeout(closeLimit);
    };
    const settle = (code, signal) => {
      if (finished) return;
      finished = true;
      clear();
      if (failed || code !== 0 || signal !== null || total < 5) {
        const error = new Error(label);
        if (
          !failed &&
          code !== 0 &&
          signal === null &&
          option === "--sdk-self-check" &&
          total >= 5
        )
          error.probeDiagnostic = sdkFailureDiagnostic(
            Buffer.concat(chunks, total),
          );
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks, total));
    };
    const fail = () => {
      if (failed || finished) return;
      failed = true;
      chunks = [];
      if (child.pid !== undefined) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* close limit still applies */
        }
        escalation = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* close limit still applies */
          }
        }, 500);
      }
      closeLimit = setTimeout(() => settle(null, null), 2500);
    };
    const deadline = setTimeout(fail, timeoutMs);
    // Keep error listeners through close, including a late spawn/stream error.
    child.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdout.on("data", (chunk) => {
      if (failed || finished) return;
      total += chunk.length;
      if (total > MAX_FRAME) fail();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (chunk.length) fail();
    });
    child.once("close", settle);
  });
}
