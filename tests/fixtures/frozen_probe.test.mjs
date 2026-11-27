import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  decodeFrame,
  runProbe,
  validateMetadata,
  validateSdk,
} from "../../scripts/frozen_probe.mjs";

const metadata = {
  schema: 1,
  python: "3.13.17 (main)",
  openssl: "OpenSSL 3",
  sqlite: "3.50",
  sdk: "1.0.25",
  certifi: "2026.10.19",
  frozen: true,
  ssl_module: "_ssl.pyd",
  bundle: "bundle",
  trust: {
    verify_mode: 2,
    check_hostname: true,
    verify_flags: 4,
    store: { x509: 0, x509_ca: 0, crl: 0 },
    default_paths: {
      cafile: null,
      capath: null,
      openssl_cafile_env: "SSL_CERT_FILE",
      openssl_cafile: "cert.pem",
      openssl_capath_env: "SSL_CERT_DIR",
      openssl_capath: "certs",
    },
    cafile_exists: false,
    capath_exists: false,
  },
  environment_overrides: {
    SSL_CERT_FILE: false,
    SSL_CERT_DIR: false,
    SSLKEYLOGFILE: false,
    HTTPS_PROXY: false,
    ALL_PROXY: false,
  },
};
const sdk = {
  schema: 1,
  status: "pass",
  stage: "complete",
  category: "none",
  sdk: "1.0.25",
  python: "3.13.17",
  frozen: true,
};
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
function rawFrame(text) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

test("fixed frames accept exact metadata and SDK contracts", () => {
  assert.equal(validateMetadata(decodeFrame(frame(metadata))).frozen, true);
  assert.deepEqual(validateSdk(decodeFrame(frame(sdk))), sdk);
});

test("frame rejects lengths, trailing bytes, invalid UTF-8, duplicate and nonfinite JSON", () => {
  for (const bytes of [
    Buffer.alloc(3),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 64, 1]),
    Buffer.concat([frame(sdk), Buffer.from("x")]),
    Buffer.from([0, 0, 0, 1, 0xff]),
    rawFrame('{"schema":1,"schema":1}'),
    rawFrame('{"\\u0073chema":1,"schema":1}'),
    rawFrame('{"n":1e999}'),
  ])
    assert.throws(() => decodeFrame(bytes), /Invalid fixed probe frame/);
});

test("depth limit distinguishes a deep object value from an ordinary shallow object", () => {
  assert.deepEqual(decodeFrame(rawFrame('{"nested":[[0]]}')), {
    nested: [[0]],
  });
  const deep = `{"nested":${"[".repeat(40)}0${"]".repeat(40)}}`;
  assert.throws(() => decodeFrame(rawFrame(deep)), /Invalid fixed probe frame/);
});

test("metadata rejects extra, type, version, frozen and override drift", () => {
  const changes = [
    { ...metadata, unexpected: 1 },
    { ...metadata, sdk: "1.0.26" },
    { ...metadata, python: "3.13.170 (main)" },
    { ...metadata, frozen: false },
    { ...metadata, ssl_module: "unavailable" },
    { ...metadata, trust: { ...metadata.trust, verify_flags: 1.5 } },
    {
      ...metadata,
      trust: {
        ...metadata.trust,
        store: { ...metadata.trust.store, x509: -1 },
      },
    },
    {
      ...metadata,
      environment_overrides: {
        ...metadata.environment_overrides,
        HTTPS_PROXY: true,
      },
    },
    {
      ...metadata,
      environment_overrides: {
        ...metadata.environment_overrides,
        extra: false,
      },
    },
  ];
  for (const value of changes)
    assert.throws(() => validateMetadata(value), /Invalid metadata probe/);
});

test("SDK rejects inconsistent and widened results", () => {
  for (const value of [
    { ...sdk, status: "fail" },
    { ...sdk, category: "blocked_network" },
    { ...sdk, stage: "sdk_construct" },
    { ...sdk, sdk: "unavailable" },
    { ...sdk, python: "3.13.18" },
    { ...sdk, frozen: false },
    { ...sdk, unexpected: true },
    { ...sdk, schema: true },
  ])
    assert.throws(() => validateSdk(value), /Invalid SDK probe/);
});

test("owned child lifecycle handles split success and closed failures without raw diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-fixed-test-"));
  try {
    const cases = [
      {
        script:
          "process.stdout.write(Buffer.from([0,0]));setTimeout(()=>process.stdout.write(Buffer.from([0,2,123,125])),10)",
        ok: true,
      },
      {
        script:
          "process.stderr.write('SYNTHETIC_SECRET');process.stdout.write(Buffer.from([0,0,0,2,123,125]))",
      },
      { script: "process.exit(7)" },
      { script: "process.kill(process.pid,'SIGTERM')" },
      { script: "setInterval(()=>{},1000)", timeout: 30 },
      {
        script:
          "process.stdout.write(Buffer.alloc(17000,65));setInterval(()=>{},1000)",
      },
    ];
    for (const item of cases) {
      const launch = (executable, argv, options) => {
        assert.equal(executable, "/fixed/sage-core");
        assert.deepEqual(argv, ["--self-check"]);
        assert.equal(options.cwd, root);
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        return spawn(process.execPath, ["-e", item.script], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
        });
      };
      const result = runProbe(
        "/fixed/sage-core",
        "--self-check",
        root,
        {},
        { spawnProcess: launch, timeoutMs: item.timeout ?? 1000 },
      );
      if (item.ok) assert.deepEqual(decodeFrame(await result), {});
      else
        await assert.rejects(
          result,
          (error) => !String(error).includes("SYNTHETIC_SECRET"),
        );
    }
    await assert.rejects(
      runProbe(
        "/fixed/sage-core",
        "--sdk-self-check",
        root,
        {},
        {
          spawnProcess: () =>
            spawn("/__missing_fixed_probe__", [], {
              stdio: ["ignore", "pipe", "pipe"],
            }),
          timeoutMs: 100,
        },
      ),
      /SDK probe/,
    );
    const failure = {
      ...sdk,
      status: "fail",
      stage: "sdk_import",
      category: "blocked_native",
    };
    const encoded = frame(failure).toString("base64");
    const launchFailure = () =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdout.write(Buffer.from('${encoded}','base64'));process.exitCode=1`,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
    await assert.rejects(
      runProbe(
        "/fixed/sage-core",
        "--sdk-self-check",
        root,
        {},
        { spawnProcess: launchFailure },
      ),
      (error) => {
        assert.equal(
          error.probeDiagnostic,
          "SDK probe sdk_import/blocked_native",
        );
        return true;
      },
    );
    const streamFailure = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stdout.emit("error", new Error("SYNTHETIC_SECRET"));
        child.emit("close", null, null);
        child.emit("error", new Error("SYNTHETIC_SECRET"));
      });
      return child;
    };
    await assert.rejects(
      runProbe(
        "/fixed/sage-core",
        "--self-check",
        root,
        {},
        {
          spawnProcess: streamFailure,
        },
      ),
      (error) => !String(error).includes("SYNTHETIC_SECRET"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
