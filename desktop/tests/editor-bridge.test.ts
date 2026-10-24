import {
  parseCodeJobView,
  type CodingControlInput,
  type HostCodingReply,
} from "../shared/coding-contracts";
import { makeProposal, makeReceipt } from "./coding-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { connect, createServer, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { EditorBridgeHost } from "../main/editor-bridge";
import { ExtensionBridge } from "../../extension/src/bridge";
import { encodeFrame, FrameDecoder } from "../shared/framing";
import {
  clientProof,
  workspaceCommitment,
  initialTranscript,
  rootIdentity,
  hostProof,
  deriveKey,
  transcript,
  envelope,
  openEnvelope,
  parseBridgeData,
  parseContextOffer,
  type ContextOffer,
  type PairView,
  type BridgeData,
  type LocalWorkspace,
} from "../shared/editor-bridge";
const resources: { close(): Promise<void> }[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(resources.splice(0).map((item) => item.close()));
});
const workspace: LocalWorkspace = {
  root_uri: "file:///tmp/sage-owned",
  root_file_id: "fixture-root",
  window_id: "window-1",
};
const wait = (ms = 20) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const capturedAt = Date.now();
function context(
  view: PairView,
): Extract<BridgeData, { kind: "context.offer" }> {
  const binding = {
    job_id: "job-1",
    boot_id: view.host_boot_id,
    pair_id: view.pair_id,
    window_id: view.window_id,
    root_id: view.root_id,
    revision: 1,
    policy_version: "code-v1" as const,
  };
  return {
    kind: "context.offer",
    binding,
    payload: {
      captured_at_ms: capturedAt,
      expires_at_ms: capturedAt + 1800000,
      context: {
        binding,
        mode: "create_focus_project",
        root_uri: workspace.root_uri,
        root_file_id: workspace.root_file_id,
        files: [],
        context_hash: "a".repeat(64),
      },
    },
  };
}
async function setup(
  confirm = true,
  onData: (message: BridgeData) => void | Promise<void> = () => {},
  options: Partial<ConstructorParameters<typeof EditorBridgeHost>[0]> = {},
) {
  let offered: PairView | undefined;
  const host = new EditorBridgeHost({
    ...options,
    onData,
    onPair: (view) => {
      offered = view;
    },
  });
  const client = new ExtensionBridge({ confirm: async () => confirm });
  resources.push(host, client);
  const ticket = await host.start();
  const pairing = client.pair(
    Buffer.from(JSON.stringify(ticket)).toString("base64url"),
    workspace,
  );
  pairing.catch(() => {});
  for (let i = 0; i < 100 && !offered; i++) await wait(2);
  return {
    host,
    client,
    ticket,
    pairing,
    get view() {
      if (!offered) throw Error("No authenticated view");
      return offered;
    },
  };
}
function selectedContext(
  view: PairView,
): Extract<BridgeData, { kind: "context.offer" }> {
  const base = context(view);
  const payload = base.payload as ContextOffer;
  return {
    kind: "context.offer",
    binding: base.binding,
    payload: {
      ...payload,
      context: {
        ...payload.context,
        mode: "replace_focus_file",
        target: "index.html",
        files: [
          {
            name: "index.html",
            text: "SYNTHETIC_SELECTED_SOURCE",
            text_hash: "a".repeat(64),
            disk_hash: "a".repeat(64),
            document_version: 1,
            file_id: "selected-file",
          },
        ],
      },
    },
  };
}
it("holds synthetic selected context until mutual proof and both local confirmations", async () => {
  const received: BridgeData[] = [];
  const s = await setup(true, (value) => {
    received.push(value);
  });
  await expect(s.client.send(selectedContext(s.view))).rejects.toThrow();
  expect(received).toEqual([]);
  expect(s.view.status).toBe("awaiting_confirmation");
  expect(await s.host.confirm(s.view.pair_id)).toMatchObject({
    status: "paired",
  });
  const view = await s.pairing;
  await s.client.send(selectedContext(view));
  await wait();
  expect(received).toEqual([selectedContext(view)]);
  await s.host.revoke();
  await wait();
  await expect(s.client.send(selectedContext(view))).rejects.toThrow();
});
it("local decline disposes authentication and sends no selected context", async () => {
  const received: BridgeData[] = [];
  const s = await setup(false, (value) => {
    received.push(value);
  });
  await expect(s.pairing).rejects.toThrow();
  expect(received).toEqual([]);
  await expect(s.host.confirm(s.view.pair_id)).rejects.toThrow();
});
it("rejects replayed tickets, a second peer and confirmation for another pair", async () => {
  const s = await setup();
  await expect(s.host.confirm("wrong")).rejects.toThrow();
  await s.host.confirm(s.view.pair_id);
  await s.pairing;
  const other = new ExtensionBridge({ confirm: async () => true });
  resources.push(other);
  await expect(
    other.pair(Buffer.from(JSON.stringify(s.ticket)).toString("base64url"), {
      ...workspace,
      window_id: "other",
    }),
  ).rejects.toThrow();
  await expect(s.host.start()).rejects.toThrow();
});
it("expires unused tickets and detects clock rollback before accepting proof", async () => {
  let now = 1000;
  const host = new EditorBridgeHost({
    now: () => now,
    onData: () => {},
    onPair: () => {},
  });
  resources.push(host);
  const ticket = await host.start();
  now += 60_001;
  const client = new ExtensionBridge({ confirm: async () => true });
  resources.push(client);
  await expect(
    client.pair(
      Buffer.from(JSON.stringify(ticket)).toString("base64url"),
      workspace,
    ),
  ).rejects.toThrow();
  await host.revoke();
  now = 1000;
  const fresh = await host.start();
  now = 999;
  await expect(
    client.pair(
      Buffer.from(JSON.stringify(fresh)).toString("base64url"),
      workspace,
    ),
  ).rejects.toThrow();
});
it("refuses wrong ticket secret without invoking confirmation or data", async () => {
  const received: BridgeData[] = [];
  const confirm = vi.fn(async () => true);
  const host = new EditorBridgeHost({
    onData: (v) => {
      received.push(v);
    },
    onPair: () => {},
  });
  resources.push(host);
  const ticket = await host.start();
  const client = new ExtensionBridge({ confirm });
  resources.push(client);
  await expect(
    client.pair(
      Buffer.from(
        JSON.stringify({
          ...ticket,
          secret: Buffer.alloc(32, 9).toString("base64url"),
        }),
      ).toString("base64url"),
      workspace,
    ),
  ).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled();
  expect(received).toEqual([]);
});
it.each([
  Buffer.from("GET / HTTP/1.1\r\n\r\n"),
  Buffer.from([0, 16, 0, 1]),
  Buffer.from([0, 0, 0, 1, 255]),
  encodeFrame({ version: 1, kind: "hello", unknown: true }),
  (() => {
    const b = Buffer.from('{"version":1,"version":1}');
    const h = Buffer.alloc(4);
    h.writeUInt32BE(b.length);
    return Buffer.concat([h, b]);
  })(),
])(
  "closes malformed unauthenticated probes without metadata",
  async (bytes) => {
    const host = new EditorBridgeHost({
      onData: () => {
        throw Error("Unexpected data");
      },
      onPair: () => {
        throw Error("Unexpected identity");
      },
    });
    resources.push(host);
    const ticket = await host.start();
    const socket = connect({ host: "127.0.0.1", port: ticket.port });
    sockets.push(socket);
    const received: Buffer[] = [];
    socket.on("data", (b) => received.push(b));
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.write(bytes);
    await closed;
    expect(Buffer.concat(received).length).toBe(0);
  },
);
it("bounds simultaneous unauthenticated peers and closes incomplete prefix/body on disconnect", async () => {
  const host = new EditorBridgeHost({ onData: () => {}, onPair: () => {} });
  resources.push(host);
  const ticket = await host.start();
  const open = () => {
    const socket = connect({ host: "127.0.0.1", port: ticket.port });
    sockets.push(socket);
    return socket;
  };
  const a = open(),
    b = open();
  await Promise.all([
    new Promise<void>((r) => a.once("connect", r)),
    new Promise<void>((r) => b.once("connect", r)),
  ]);
  const c = open();
  await new Promise<void>((r) => c.once("close", () => r()));
  a.write(Buffer.from([0]));
  b.write(Buffer.from([0, 0, 0, 3, 123]));
  a.end();
  b.end();
  await wait();
  expect(a.destroyed && b.destroyed).toBe(true);
});
it("awaits callbacks serially and closes on the ninth pending authenticated frame", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received: BridgeData[] = [];
  const s = await setup(true, async (v) => {
    received.push(v);
    await held;
  });
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const queued: BridgeData = {
    kind: "result.dismissed",
    binding: context(view).binding,
    payload: null,
  };
  for (let i = 0; i < 8; i++) await s.client.send(queued);
  await wait();
  expect(received).toHaveLength(1);
  await s.client.send(queued);
  await wait();
  release();
  await wait();
  expect(received).toHaveLength(1);
  await expect(
    s.host.send({
      kind: "revoke",
      binding: context(view).binding,
      payload: null,
    }),
  ).rejects.toThrow();
});
it("callback rejection prevents further source dispatch", async () => {
  const received: BridgeData[] = [];
  const s = await setup(true, (v) => {
    received.push(v);
    throw Error("Rejected context");
  });
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  await s.client.send(context(view));
  await wait();
  await expect(s.client.send(context(view))).rejects.toThrow();
  expect(received).toHaveLength(1);
});
it("uses independent nonce, transcript, HKDF and direction MAC vectors", () => {
  const view: PairView = {
    host_boot_id: "boot",
    pair_id: "pair",
    window_id: "window",
    root_id: "root",
    root_uri: "file:///tmp/sage-owned",
    root_file_id: "file",
    challenge: "",
    status: "awaiting_confirmation",
  };
  const c = Buffer.alloc(32, 1),
    s = Buffer.alloc(32, 2),
    secret = Buffer.alloc(32, 3);
  const commitment = workspaceCommitment(
    secret,
    {
      root_uri: view.root_uri,
      root_file_id: view.root_file_id,
      window_id: view.window_id,
    },
    c,
  );
  const initial = initialTranscript(
    12345,
    view.host_boot_id,
    view.pair_id,
    c,
    s,
    commitment,
  );
  expect(commitment).toBe("x51kWSGetoHhU89nYm6R_q03tZHdInsdjtFIz_XTEY0");
  expect(initial.toString()).toBe(
    '[1,12345,"boot","pair","AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","x51kWSGetoHhU89nYm6R_q03tZHdInsdjtFIz_XTEY0"]',
  );
  const bytes = transcript(view, c, s, 12345, commitment);
  expect(bytes.toString()).toBe(
    '[1,12345,"boot","pair","AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE","AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI","x51kWSGetoHhU89nYm6R_q03tZHdInsdjtFIz_XTEY0","window","root","file:///tmp/sage-owned","file"]',
  );
  expect(clientProof(secret, bytes)).toBe(
    "3K2EjldYtLnXiiGIIW1If0ONoZaMbS0Msd6-IhDS05U",
  );
  expect(hostProof(secret, initial)).toBe(
    "TcRlHLQDmQk21u6pwzba4dhOXcEo6u-i-gJdaP5IT24",
  );
  for (const initialBytes of [
    initialTranscript(12346, "boot", "pair", c, s, commitment),
    initialTranscript(12345, "other", "pair", c, s, commitment),
    initialTranscript(12345, "boot", "other", c, s, commitment),
    initialTranscript(
      12345,
      "boot",
      "pair",
      Buffer.alloc(32, 9),
      s,
      commitment,
    ),
    initialTranscript(
      12345,
      "boot",
      "pair",
      c,
      Buffer.alloc(32, 9),
      commitment,
    ),
    initialTranscript(
      12345,
      "boot",
      "pair",
      c,
      s,
      Buffer.alloc(32, 9).toString("base64url"),
    ),
  ])
    expect(hostProof(secret, initialBytes)).not.toBe(
      "TcRlHLQDmQk21u6pwzba4dhOXcEo6u-i-gJdaP5IT24",
    );
  for (const field of [
    "window_id",
    "root_id",
    "root_uri",
    "root_file_id",
  ] as const)
    expect(
      clientProof(
        secret,
        transcript(
          {
            ...view,
            [field]: field === "root_uri" ? "file:///other" : "other",
          },
          c,
          s,
          12345,
          commitment,
        ),
      ),
    ).not.toBe("3K2EjldYtLnXiiGIIW1If0ONoZaMbS0Msd6-IhDS05U");
  for (const field of ["window_id", "root_uri", "root_file_id"] as const)
    expect(
      workspaceCommitment(
        secret,
        {
          root_uri: view.root_uri,
          root_file_id: view.root_file_id,
          window_id: view.window_id,
          [field]: field === "root_uri" ? "file:///other" : "other",
        },
        c,
      ),
    ).not.toBe("x51kWSGetoHhU89nYm6R_q03tZHdInsdjtFIz_XTEY0");
  const key = deriveKey(secret, c, s);
  expect(key.toString("hex")).toBe(
    "a932aec749a3dd86354b9eb34f491a252d463febb39c2ca23bfee53c2f9fe45a",
  );
  const body = {
    version: 1,
    kind: "control.client-confirm",
    host_boot_id: "boot",
    pair_id: "pair",
    window_id: "window",
    root_id: "root",
  };
  const wrapped = envelope(key, "extension", 1, body);
  expect(wrapped.mac).toBe("9efZBMPGjtMAuevlgbOafkea7YxroZdxF_9K9-ecKzQ");
  expect(openEnvelope(key, "extension", 1, wrapped)).toEqual(body);
  for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])
    expect(() => envelope(key, "extension", seq, body)).toThrow();
  expect(() => openEnvelope(key, "host", 1, wrapped)).toThrow();
  expect(() => openEnvelope(key, "extension", 2, wrapped)).toThrow();
  expect(() =>
    openEnvelope(key, "extension", 1, { ...wrapped, mac: "A" }),
  ).toThrow();
  expect(() =>
    openEnvelope(key, "extension", 1, { ...wrapped, extra: 1 }),
  ).toThrow();
  expect(() =>
    envelope(key, "extension", 1, { text: "x".repeat(800000) }),
  ).toThrow();
});
it("validates exact pair identity, direction, nested binding and no wire native fields", async () => {
  const s = await setup();
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const value = context(view);
  expect(parseBridgeData(value, "extension", view)).toEqual(value);
  for (const field of ["boot_id", "pair_id", "window_id", "root_id"])
    expect(() =>
      parseBridgeData(
        { ...value, binding: { ...value.binding, [field]: "wrong" } },
        "extension",
        view,
      ),
    ).toThrow();
  for (const modified of [
    { ...value, command: "execute" },
    {
      ...value,
      payload: { ...(value.payload as ContextOffer), read_path: "/private" },
    },
    {
      ...value,
      payload: {
        ...(value.payload as ContextOffer),
        context: {
          ...(value.payload as ContextOffer).context,
          binding: { ...value.binding, job_id: "wrong" },
        },
      },
    },
  ])
    expect(() => parseBridgeData(modified, "extension", view)).toThrow();
  expect(() => parseBridgeData(value, "host", view)).toThrow();
  await expect(s.host.send(value)).rejects.toThrow();
  const proposal = {
    kind: "proposal.offer",
    binding: value.binding,
    payload: {
      job_id: "job-1",
      revision: 1,
      explanation: "Synthetic marker only",
      files: [
        { name: "index.html", text: "" },
        { name: "focus.js", text: "" },
        { name: "focus.test.mjs", text: "" },
        { name: "README.md", text: "" },
      ],
    },
  };
  expect(() => parseBridgeData(proposal, "host", view)).toThrow();
  expect(
    parseBridgeData(
      proposal,
      "host",
      view,
      (value.payload as ContextOffer).context,
    ),
  ).toEqual(proposal);
  expect(
    createHash("sha256").update(JSON.stringify(value)).digest("hex"),
  ).toHaveLength(64);
});
it("forged host proof never reaches the local confirmation callback", async () => {
  const server = createServer((socket) => {
    sockets.push(socket);
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        expect(message.kind).toBe("hello");
        socket.write(
          encodeFrame({
            version: 1,
            kind: "challenge",
            server_nonce: Buffer.alloc(32, 4).toString("base64url"),
            pair_id: "pair",
            root_id: "root",
            proof: Buffer.alloc(32).toString("base64url"),
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  const confirm = vi.fn(async () => true);
  const client = new ExtensionBridge({ confirm });
  resources.push(client);
  await expect(
    client.pair(
      Buffer.from(
        JSON.stringify({
          version: 1,
          port: address.port,
          host_boot_id: "boot",
          secret: Buffer.alloc(32, 3).toString("base64url"),
        }),
      ).toString("base64url"),
      workspace,
    ),
  ).rejects.toThrow();
  expect(confirm).not.toHaveBeenCalled();
});

async function rawPair(
  onData: (value: BridgeData) => void | Promise<void> = () => {},
) {
  let view: PairView | undefined;
  const host = new EditorBridgeHost({
    onData,
    onPair: (value) => {
      view = value;
    },
  });
  resources.push(host);
  const ticket = await host.start();
  const socket = connect({ host: "127.0.0.1", port: ticket.port });
  sockets.push(socket);
  const decoder = new FrameDecoder();
  const rows: Record<string, unknown>[] = [];
  socket.on("data", (chunk) => rows.push(...decoder.push(chunk)));
  const next = async () => {
    for (let i = 0; i < 100 && !rows.length; i++) await wait(2);
    const row = rows.shift();
    if (!row) throw Error("Missing raw frame");
    return row;
  };
  const client = Buffer.alloc(32, 11),
    secret = Buffer.from(ticket.secret, "base64url"),
    commitment = workspaceCommitment(secret, workspace, client);
  socket.write(
    encodeFrame({
      version: 1,
      kind: "hello",
      host_boot_id: ticket.host_boot_id,
      client_nonce: client.toString("base64url"),
      workspace_commitment: commitment,
    }),
  );
  const reply = await next(),
    server = Buffer.from(reply.server_nonce as string, "base64url");
  const offered = {
    ...workspace,
    host_boot_id: ticket.host_boot_id,
    pair_id: reply.pair_id as string,
    root_id: rootIdentity(workspace),
    challenge: "",
    status: "awaiting_confirmation" as const,
  };
  const bytes = transcript(offered, client, server, ticket.port, commitment),
    key = deriveKey(secret, client, server);
  socket.write(
    encodeFrame({
      version: 1,
      kind: "authenticate",
      workspace,
      proof: clientProof(secret, bytes),
    }),
  );
  await next();
  for (let i = 0; i < 100 && !view; i++) await wait(2);
  if (!view) throw Error("Missing authenticated identity");
  socket.write(
    encodeFrame(
      envelope(key, "extension", 1, {
        version: 1,
        kind: "control.client-confirm",
        host_boot_id: view.host_boot_id,
        pair_id: view.pair_id,
        window_id: view.window_id,
        root_id: view.root_id,
      }),
    ),
  );
  await host.confirm(view.pair_id);
  await next();
  const bound = view;
  return {
    host,
    socket,
    key,
    view: bound,
    data: (data: unknown, seq = 2) =>
      envelope(key, "extension", seq, {
        version: 1,
        kind: "data",
        host_boot_id: bound.host_boot_id,
        pair_id: bound.pair_id,
        window_id: bound.window_id,
        root_id: bound.root_id,
        data,
      }),
  };
}
it.each([
  "bad-mac",
  "sequence-repeat",
  "sequence-skip",
  "unsafe-sequence",
  "wrong-boot",
  "wrong-pair",
  "wrong-window",
  "wrong-root",
  "wrong-job",
  "unknown-native",
  "payload-extra",
])("closes authenticated %s without dispatch", async (kind) => {
  const received: BridgeData[] = [];
  const raw = await rawPair((value) => {
    received.push(value);
  });
  let data: unknown = context(raw.view);
  let frame = raw.data(data);
  if (kind === "bad-mac")
    frame = { ...frame, mac: Buffer.alloc(32, 9).toString("base64url") };
  if (kind === "sequence-repeat") frame = raw.data(data, 1);
  if (kind === "sequence-skip") frame = raw.data(data, 3);
  if (kind === "unsafe-sequence")
    frame = { ...frame, sequence: Number.MAX_SAFE_INTEGER + 1 };
  if (kind.startsWith("wrong-")) {
    const field = {
      "wrong-boot": "boot_id",
      "wrong-pair": "pair_id",
      "wrong-window": "window_id",
      "wrong-root": "root_id",
      "wrong-job": "job_id",
    }[kind]!;
    const value = data as Extract<BridgeData, { kind: "context.offer" }>;
    data = { ...value, binding: { ...value.binding, [field]: "other" } };
    frame = raw.data(data);
  }
  if (kind === "unknown-native")
    frame = raw.data({
      kind: "execute",
      binding: context(raw.view).binding,
      payload: { command: "SYNTHETIC_FORBIDDEN" },
    });
  if (kind === "payload-extra")
    frame = raw.data({
      ...context(raw.view),
      payload: {
        ...(context(raw.view).payload as ContextOffer),
        read_path: "SYNTHETIC_FORBIDDEN",
      },
    });
  const closed = new Promise<void>((resolve) =>
    raw.socket.once("close", () => resolve()),
  );
  raw.socket.write(encodeFrame(frame));
  await closed;
  expect(received).toEqual([]);
});
it("host sends only schema-checked proposals for accepted context; dismissal clears source cache", async () => {
  const s = await setup();
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const received: BridgeData[] = [];
  const off = s.client.onData((value) => {
    received.push(value);
  });
  const selected = context(view);
  await s.client.send(selected);
  await wait();
  const proposal: BridgeData = {
    kind: "proposal.offer",
    binding: selected.binding,
    payload: {
      job_id: selected.binding.job_id,
      revision: 1,
      explanation: "Review locally",
      files: [
        { name: "index.html", text: "SYNTHETIC_SOURCE" },
        { name: "focus.js", text: "" },
        { name: "focus.test.mjs", text: "" },
        { name: "README.md", text: "" },
      ],
    },
  };
  await s.host.send(proposal);
  await wait();
  expect(received).toEqual([proposal]);
  off();
  await s.client.send({
    kind: "result.dismissed",
    binding: selected.binding,
    payload: null,
  });
  await wait();
  await expect(s.host.send(proposal)).rejects.toThrow();
});
it("client's fixed confirmation callback is required even after host confirms", async () => {
  let release!: (value: boolean) => void;
  const decision = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  let view: PairView | undefined;
  const received: BridgeData[] = [];
  const host = new EditorBridgeHost({
    onData: (value) => {
      received.push(value);
    },
    onPair: (value) => {
      view = value;
    },
  });
  const client = new ExtensionBridge({ confirm: () => decision });
  resources.push(host, client);
  const ticket = await host.start();
  const pairing = client.pair(
    Buffer.from(JSON.stringify(ticket)).toString("base64url"),
    workspace,
  );
  pairing.catch(() => {});
  for (let i = 0; i < 100 && !view; i++) await wait(2);
  if (!view) throw Error("Missing host view");
  const confirmed = host.confirm(view.pair_id);
  await expect(client.send(context(view))).rejects.toThrow();
  expect(received).toEqual([]);
  release(true);
  await confirmed;
  await pairing;
});
it("eighth queued write is bounded; ninth closes a real paused socket without hanging promises", async () => {
  const { FramedPeer } = await import("../shared/editor-bridge");
  const peers: import("../shared/editor-bridge").FramedPeer[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.pause();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  resources.push({
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing listener");
  const socket = connect({ host: "127.0.0.1", port: address.port });
  sockets.push(socket);
  await new Promise<void>((r) => socket.once("connect", r));
  const peer = new FramedPeer(socket);
  peers.push(peer);
  const sends = Array.from({ length: 9 }, () =>
    peer.write({ marker: "SYNTHETIC", body: "x".repeat(900000) }),
  );
  const results = await Promise.allSettled(sends);
  expect(results[8].status).toBe("rejected");
  expect(peer.closed).toBe(true);
  peers.forEach((p) => p.close());
});

import corpus from "../../tests/fixtures/coding-contracts.json";
import { BINDING } from "./coding-fixtures";
it("preserves reviewed job cancel_requested default across status and grant replies", () => {
  const sample = corpus.cases.find(
    (item) => item.kind === "job_view" && item.valid,
  )!;
  const job = structuredClone(sample.value) as Record<string, unknown>;
  job.binding = BINDING;
  delete job.cancel_requested;
  const view: PairView = {
    ...workspace,
    host_boot_id: BINDING.boot_id,
    pair_id: BINDING.pair_id,
    root_id: BINDING.root_id,
    challenge: "check",
    status: "paired",
  };
  expect(
    parseBridgeData(
      { kind: "job.status", binding: BINDING, payload: job },
      "host",
      view,
    ).payload,
  ).toMatchObject({ cancel_requested: false });
  expect(
    parseBridgeData(
      { kind: "grant.reply", binding: BINDING, payload: { kind: "job", job } },
      "host",
      view,
    ).payload,
  ).toMatchObject({ job: { cancel_requested: false } });
});

it("routes every approved data kind through its closed Task1 payload parser", () => {
  const view: PairView = {
    ...workspace,
    host_boot_id: BINDING.boot_id,
    pair_id: BINDING.pair_id,
    root_id: BINDING.root_id,
    challenge: "check",
    status: "paired",
  };
  const fixture = (kind: string) =>
    structuredClone(
      corpus.cases.find((item) => item.kind === kind && item.valid)!.value,
    );
  const entries: [string, "host" | "extension", unknown][] = [
    ["test.preview", "extension", fixture("recipe")],
    ["job.status", "host", fixture("job_view")],
    ["reconcile.offer", "host", fixture("job_view")],
    ["review.decision", "extension", fixture("review")],
    ["grant.reply", "host", { kind: "grant", grant: fixture("grant") }],
    ["grant.reply", "host", { kind: "receipt", receipt: fixture("receipt") }],
    ["journal.intent", "extension", fixture("intent")],
    ["journal.observed", "extension", fixture("receipt")],
    ["journal.ack", "host", fixture("ack")],
  ];
  for (const [kind, direction, payload] of entries) {
    const value = { kind, binding: BINDING, payload };
    expect(parseBridgeData(value, direction, view)).toMatchObject({
      kind,
      binding: BINDING,
    });
    expect(() =>
      parseBridgeData(value, direction === "host" ? "extension" : "host", view),
    ).toThrow();
    expect(() =>
      parseBridgeData(
        {
          ...value,
          payload: { ...(payload as object), execute: "SYNTHETIC_FORBIDDEN" },
        },
        direction,
        view,
      ),
    ).toThrow();
  }
  expect(() =>
    parseBridgeData(
      {
        kind: "test.preview",
        binding: BINDING,
        payload: { ...(fixture("recipe") as object), root_id: "other" },
      },
      "extension",
      view,
    ),
  ).toThrow();
  expect(() =>
    parseBridgeData(
      { kind: "revoke", binding: BINDING, payload: {} },
      "host",
      view,
    ),
  ).toThrow();
});
it("rejects malformed tickets, noncanonical local identity and invalid nonce sizes", async () => {
  const { parseTicket, parseWorkspace, rootIdentity } =
    await import("../shared/editor-bridge");
  const ticket = {
    version: 1,
    port: 12345,
    host_boot_id: "boot",
    secret: Buffer.alloc(32, 3).toString("base64url"),
  };
  for (const value of [
    { ...ticket, version: 2 },
    { ...ticket, port: 0 },
    { ...ticket, port: 65536 },
    { ...ticket, port: 1.5 },
    { ...ticket, port: "123" },
    { ...ticket, host_boot_id: "bad/path" },
    { ...ticket, secret: "AA" },
    { ...ticket, secret: "!" },
    { ...ticket, extra: true },
  ])
    expect(() =>
      parseTicket(Buffer.from(JSON.stringify(value)).toString("base64url")),
    ).toThrow();
  for (const value of [
    "x".repeat(1025),
    "=",
    "AB",
    Buffer.from('{"version":1,"version":1}').toString("base64url"),
  ])
    expect(() => parseTicket(value)).toThrow();
  for (const root_uri of [
    "invalid",
    "https://example.com/",
    "file://server/root",
    "file:///tmp/root#fragment",
    "file:///tmp/root?query",
    "file:///tmp/%61",
    "x".repeat(8193),
  ])
    expect(() => parseWorkspace({ ...workspace, root_uri })).toThrow();
  for (const value of [null, [], {}, { ...workspace, root_file_id: "" }])
    expect(() => parseWorkspace(value)).toThrow();
  expect(() =>
    transcript(
      {} as PairView,
      Buffer.alloc(31),
      Buffer.alloc(32),
      12345,
      Buffer.alloc(32).toString("base64url"),
    ),
  ).toThrow();
  expect(() => clientProof(Buffer.alloc(0), Buffer.alloc(0))).toThrow();
  expect(() =>
    deriveKey(Buffer.alloc(0), Buffer.alloc(32), Buffer.alloc(32)),
  ).toThrow();
  expect(rootIdentity(workspace)).toBe(
    "b46f51a3bf793878e1393f3d63f4ce40efc87d202e8676908580df048ae4a9da",
  );
  expect(rootIdentity({ ...workspace, window_id: "another" })).toBe(
    "b46f51a3bf793878e1393f3d63f4ce40efc87d202e8676908580df048ae4a9da",
  );
});
it("original ticket deadline closes an authenticated but locally unconfirmed pair", async () => {
  let now = 1000,
    asked = 0;
  const received: BridgeData[] = [];
  const host = new EditorBridgeHost({
    now: () => now,
    onPair: () => {},
    onData: (value) => {
      received.push(value);
    },
  });
  const client = new ExtensionBridge({
    confirm: async () => {
      asked++;
      return new Promise<boolean>(() => {});
    },
  });
  resources.push(host, client);
  const ticket = await host.start();
  now = 60_900;
  await expect(
    client.pair(
      Buffer.from(JSON.stringify(ticket)).toString("base64url"),
      workspace,
    ),
  ).rejects.toThrow();
  expect(asked).toBe(1);
  expect(received).toEqual([]);
});
it("incomplete prefix and body are closed by the actual ten-second authentication deadline", async () => {
  const host = new EditorBridgeHost({
    onPair: () => {
      throw Error("Unexpected identity");
    },
    onData: () => {
      throw Error("Unexpected source");
    },
  });
  resources.push(host);
  const ticket = await host.start();
  const probes = [Buffer.from([0]), Buffer.from([0, 0, 0, 3, 123])];
  await Promise.all(
    probes.map(async (bytes) => {
      const socket = connect({ host: "127.0.0.1", port: ticket.port });
      sockets.push(socket);
      const closed = new Promise<void>((r) => socket.once("close", () => r()));
      socket.write(bytes);
      await closed;
    }),
  );
}, 15_000);
it("changed workspace guard revokes credentials instead of only refusing one local send", async () => {
  let changed = false,
    view: PairView | undefined;
  const received: BridgeData[] = [];
  const host = new EditorBridgeHost({
    onPair: (value) => {
      view = value;
    },
    onData: (value) => {
      received.push(value);
    },
  });
  const client = new ExtensionBridge({
    confirm: async () => true,
    guard: () => {
      if (changed) throw Error("Workspace changed");
    },
  });
  resources.push(host, client);
  const ticket = await host.start();
  const pairing = client.pair(
    Buffer.from(JSON.stringify(ticket)).toString("base64url"),
    workspace,
  );
  for (let i = 0; i < 100 && !view; i++) await wait(2);
  if (!view) throw Error("Missing identity");
  await host.confirm(view.pair_id);
  const paired = await pairing;
  changed = true;
  await expect(client.send(context(paired))).rejects.toThrow();
  await wait();
  await expect(
    host.send({
      kind: "revoke",
      binding: context(paired).binding,
      payload: null,
    }),
  ).rejects.toThrow();
  expect(received).toEqual([]);
});
it.each(["forged-proof", "workspace-mismatch"])(
  "%s yields no authenticated identity or selected source callback",
  async (mode) => {
    let identities = 0;
    const received: BridgeData[] = [];
    const host = new EditorBridgeHost({
      onPair: () => {
        identities++;
      },
      onData: (value) => {
        received.push(value);
      },
    });
    resources.push(host);
    const ticket = await host.start();
    const socket = connect({ host: "127.0.0.1", port: ticket.port });
    sockets.push(socket);
    const decoder = new FrameDecoder();
    let challengeFrame: Record<string, unknown> | undefined;
    const challengeReceived = new Promise<void>((resolve) =>
      socket.on("data", (chunk) => {
        for (const message of decoder.push(chunk)) {
          expect(message.kind).toBe("challenge");
          challengeFrame = message;
          resolve();
        }
      }),
    );
    socket.write(
      encodeFrame({
        version: 1,
        kind: "hello",
        host_boot_id: ticket.host_boot_id,
        client_nonce: Buffer.alloc(32, 5).toString("base64url"),
        workspace_commitment: workspaceCommitment(
          Buffer.from(ticket.secret, "base64url"),
          workspace,
          Buffer.alloc(32, 5),
        ),
      }),
    );
    await challengeReceived;
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    const chosen =
      mode === "workspace-mismatch"
        ? { ...workspace, root_uri: "file:///tmp/other", root_file_id: "other" }
        : workspace;
    const commitment = workspaceCommitment(
      Buffer.from(ticket.secret, "base64url"),
      workspace,
      Buffer.alloc(32, 5),
    );
    const view: PairView = {
      ...chosen,
      host_boot_id: ticket.host_boot_id,
      pair_id: challengeFrame!.pair_id as string,
      root_id: rootIdentity(chosen),
      status: "awaiting_confirmation",
      challenge: "",
    };
    const proof =
      mode === "forged-proof"
        ? Buffer.alloc(32).toString("base64url")
        : clientProof(
            Buffer.from(ticket.secret, "base64url"),
            transcript(
              view,
              Buffer.alloc(32, 5),
              Buffer.from(challengeFrame!.server_nonce as string, "base64url"),
              ticket.port,
              commitment,
            ),
          );
    socket.write(
      encodeFrame({
        version: 1,
        kind: "authenticate",
        workspace: chosen,
        proof,
      }),
    );
    await closed;
    expect(identities).toBe(0);
    expect(received).toEqual([]);
  },
);
it.each(["malformed", "forged", "replayed"])(
  "unverified %s host challenge receives no plaintext folder/window/source identity",
  async (mode) => {
    const secret = Buffer.alloc(32, 23),
      received: Record<string, unknown>[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        for (const message of decoder.push(chunk)) {
          received.push(message);
          const address = server.address();
          if (!address || typeof address === "string")
            throw Error("Missing port");
          const c = Buffer.from(message.client_nonce as string, "base64url"),
            sn = Buffer.alloc(32, 4);
          const proof =
            mode === "forged"
              ? Buffer.alloc(32).toString("base64url")
              : hostProof(
                  secret,
                  initialTranscript(
                    address.port,
                    "boot",
                    "pair",
                    mode === "replayed" ? Buffer.alloc(32, 99) : c,
                    sn,
                    message.workspace_commitment as string,
                  ),
                );
          socket.write(
            encodeFrame({
              version: 1,
              kind: "challenge",
              server_nonce: sn.toString("base64url"),
              pair_id: "pair",
              ...(mode === "malformed" ? { extra: true } : {}),
              proof,
            }),
          );
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    resources.push({
      close: () => new Promise<void>((r) => server.close(() => r())),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing port");
    const client = new ExtensionBridge({
      confirm: async () => {
        throw Error("Unverified host reached confirmation");
      },
    });
    resources.push(client);
    await expect(
      client.pair(
        Buffer.from(
          JSON.stringify({
            version: 1,
            port: address.port,
            host_boot_id: "boot",
            secret: secret.toString("base64url"),
          }),
        ).toString("base64url"),
        {
          root_uri: "file:///private/private-root-before-proof",
          root_file_id: "private-file-before-proof",
          window_id: "private-window-before-proof",
        },
      ),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
    const actual = JSON.stringify(received);
    for (const marker of [
      "private-root-before-proof",
      "private-file-before-proof",
      "private-window-before-proof",
      "SYNTHETIC_SELECTED_SOURCE",
    ])
      expect(actual).not.toContain(marker);
    expect(received[0]).not.toHaveProperty("workspace");
  },
);
it("closing a peer releases queued source objects while a trusted callback remains unresolved", async () => {
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  const { FramedPeer } = await import("../shared/editor-bridge");
  let queued: WeakRef<Record<string, unknown>> | undefined;
  const original = FrameDecoder.prototype.push;
  const decoder = vi
    .spyOn(FrameDecoder.prototype, "push")
    .mockImplementation(function (
      this: FrameDecoder,
      chunk: Buffer,
      max?: number,
    ) {
      const rows = original.call(this, chunk, max);
      for (const row of rows)
        if (row.kind === "queue-test" && row.id === 2)
          queued = new WeakRef(row);
      return rows;
    });
  let peer: import("../shared/editor-bridge").FramedPeer | undefined,
    entered = 0,
    release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const server = createServer((socket) => {
    sockets.push(socket);
    peer = new FramedPeer(socket);
    peer.handler = async () => {
      entered++;
      await held;
    };
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  resources.push({
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  const socket = connect({ host: "127.0.0.1", port: address.port });
  sockets.push(socket);
  socket.write(
    Buffer.concat([
      encodeFrame({ kind: "queue-test", id: 1, source: "ACTIVE_SYNTHETIC" }),
      encodeFrame({ kind: "queue-test", id: 2, source: "QUEUED_SYNTHETIC" }),
    ]),
  );
  try {
    for (let i = 0; i < 100 && (!queued || entered !== 1); i++) await wait(2);
    expect(entered).toBe(1);
    expect(queued?.deref()).toBeDefined();
    decoder.mockClear();
    peer!.close();
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((r) => setImmediate(r));
      collect();
    }
    expect(queued?.deref()).toBeUndefined();
    expect(entered).toBe(1);
  } finally {
    release();
    decoder.mockRestore();
    peer?.close();
    setFlagsFromString("--no-expose-gc");
  }
});
it("send rejects when its completed write also observed local transport closure", async () => {
  const { FramedPeer, BridgeSession } = await import("../shared/editor-bridge");
  const key = Buffer.alloc(32, 17);
  const view: PairView = {
    ...workspace,
    host_boot_id: "boot",
    pair_id: "pair",
    root_id: "root",
    challenge: "challenge",
    status: "awaiting_confirmation",
  };
  const server = createServer((socket) => {
    sockets.push(socket);
    const common = {
      version: 1,
      host_boot_id: view.host_boot_id,
      pair_id: view.pair_id,
      window_id: view.window_id,
      root_id: view.root_id,
    };
    socket.write(
      encodeFrame(
        envelope(key, "host", 1, { ...common, kind: "control.authenticated" }),
      ),
    );
    socket.write(
      encodeFrame(
        envelope(key, "host", 2, { ...common, kind: "control.host-confirm" }),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  resources.push({
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing port");
  const socket = connect({ host: "127.0.0.1", port: address.port });
  sockets.push(socket);
  const peer = new FramedPeer(socket);
  const session = new BridgeSession(
    peer,
    Buffer.from(key),
    "extension",
    view,
    () => {},
  );
  resources.push({ close: async () => session.close() });
  await session.confirm();
  const original = peer.write.bind(peer);
  const write = vi.spyOn(peer, "write").mockImplementation(async (value) => {
    await original(value);
    peer.close();
  });
  try {
    await expect(session.send(context(view))).rejects.toThrow();
  } finally {
    write.mockRestore();
  }
});

it("rejects renewed, future, expired and malformed transport-only capture leases", () => {
  const view = {
    ...workspace,
    host_boot_id: "boot",
    pair_id: "pair",
    root_id: rootIdentity(workspace),
    challenge: "x",
    status: "paired" as const,
  };
  const value = context(view).payload as ContextOffer;
  expect(parseContextOffer(value, capturedAt)).toEqual(value);
  for (const changes of [
    { captured_at_ms: capturedAt + 1 },
    { expires_at_ms: capturedAt },
    { expires_at_ms: capturedAt + 1800001 },
    { captured_at_ms: -1 },
    { expires_at_ms: 253402300800000 },
    { extra: true },
  ])
    expect(() =>
      parseContextOffer({ ...value, ...changes }, capturedAt),
    ).toThrow();
  expect(() => parseContextOffer(value, value.expires_at_ms)).toThrow();
});

it("records local intent before core acknowledgment and refuses repeat/reconciliation as effect authority", async () => {
  const { EffectJournal, journalHash, intentProjection } =
    await import("../../extension/src/journal");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp("/private/tmp/sage-bridge-journal-");
  const journal = new EffectJournal(pathToFileURL(root));
  let calls = 0;
  const s = await setup(true, async (data) => {
    if (data.kind !== "journal.intent") throw Error("Unexpected message");
    calls++;
    expect((await journal.get(data.payload.operation_id)).intents).toHaveLength(
      1,
    );
    await s.host.send({
      kind: "journal.ack",
      binding: data.binding,
      payload: {
        operation_id: data.payload.operation_id,
        effect_id: data.payload.effect_id,
        status: "recorded",
        recorded_hash: journalHash(intentProjection(data.payload)),
      },
    });
  });
  try {
    await s.host.confirm(s.view.pair_id);
    const view = await s.pairing;
    const value = {
      binding: context(view).binding,
      operation_id: "intent-op",
      effect_id: "intent-effect",
      ordinal: 0,
      scope: "code.create" as const,
      target: "index.html" as const,
      expected_hash: "a".repeat(64),
    };
    expect((await s.client.recordIntent(journal, value)).status).toBe(
      "recorded",
    );
    expect(calls).toBe(1);
    await expect(s.client.recordIntent(journal, value)).rejects.toThrow();
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("original source lease closes both peers even while the trusted callback remains held", async () => {
  let release!: () => void, received!: () => void;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      received = r;
    });
  const s = await setup(true, async () => {
    received();
    await held;
  });
  try {
    await s.host.confirm(s.view.pair_id);
    const view = await s.pairing;
    const value = context(view);
    const offer = value.payload as ContextOffer;
    await s.client.send({
      ...value,
      payload: {
        ...offer,
        captured_at_ms: Date.now() - 100,
        expires_at_ms: Date.now() + 50,
      },
    } as BridgeData);
    await ready;
    await wait(80);
    await expect(
      s.host.send({ kind: "revoke", binding: value.binding, payload: null }),
    ).rejects.toThrow();
    await expect(
      s.client.send({
        kind: "result.dismissed",
        binding: value.binding,
        payload: null,
      }),
    ).rejects.toThrow();
  } finally {
    release();
  }
});
it("a repeated offer cannot renew cached source and rollback invalidates the pair", async () => {
  const s = await setup();
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const value = context(view);
  await s.client.send(value);
  await wait();
  await expect(s.client.send(value)).rejects.toThrow();
  const other = await setup();
  await other.host.confirm(other.view.pair_id);
  const paired = await other.pairing;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const selected = context(paired);
    await other.client.send(selected);
    clock.mockReturnValue(now - 1);
    await expect(
      other.client.send({
        kind: "result.dismissed",
        binding: selected.binding,
        payload: null,
      }),
    ).rejects.toThrow();
  } finally {
    clock.mockRestore();
  }
});
it.each([
  "duplicate",
  "conflict",
  "wrong-hash",
  "wrong-effect",
  "wrong-binding",
])(
  "rejects core %s acknowledgement and never retries durable intent",
  async (mode) => {
    const { EffectJournal, journalHash, intentProjection } =
      await import("../../extension/src/journal");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { pathToFileURL } = await import("node:url");
    const root = await mkdtemp("/private/tmp/sage-core-ack-");
    const journal = new EffectJournal(pathToFileURL(root));
    let calls = 0;
    const s = await setup(true, async (data) => {
      if (data.kind !== "journal.intent") throw Error("Unexpected");
      calls++;
      const status =
        mode === "duplicate"
          ? "duplicate"
          : mode === "conflict"
            ? "conflict"
            : "recorded";
      await s.host.send({
        kind: "journal.ack",
        binding:
          mode === "wrong-binding"
            ? { ...data.binding, job_id: "other" }
            : data.binding,
        payload: {
          operation_id: data.payload.operation_id,
          effect_id: mode === "wrong-effect" ? "other" : data.payload.effect_id,
          status,
          recorded_hash:
            status === "conflict"
              ? null
              : mode === "wrong-hash"
                ? "b".repeat(64)
                : journalHash(intentProjection(data.payload)),
        },
      });
    });
    try {
      await s.host.confirm(s.view.pair_id);
      const view = await s.pairing;
      await expect(
        s.client.recordIntent(journal, {
          binding: context(view).binding,
          operation_id: "op",
          effect_id: "effect",
          ordinal: 0,
          scope: "code.create",
          target: "index.html",
          expected_hash: "a".repeat(64),
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
      expect((await journal.get("op")).intents).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("local journal failure sends zero core intent frames", async () => {
  const { EffectJournal } = await import("../../extension/src/journal");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp("/private/tmp/sage-failed-local-");
  let calls = 0;
  const s = await setup(true, () => {
    calls++;
  });
  try {
    await s.host.confirm(s.view.pair_id);
    const view = await s.pairing;
    await writeFile(root + "/operation-op.json", "corrupt");
    await expect(
      s.client.recordIntent(new EffectJournal(pathToFileURL(root)), {
        binding: context(view).binding,
        operation_id: "op",
        effect_id: "effect",
        ordinal: 0,
        scope: "code.create",
        target: "index.html",
        expected_hash: "a".repeat(64),
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("owns acknowledgment recording before the first local durability await", async () => {
  const { EffectJournal } = await import("../../extension/src/journal");
  const { pathToFileURL } = await import("node:url");
  const journal = new EffectJournal(
    pathToFileURL("/private/tmp/sage-unused-journal"),
  );
  let release!: (value: import("../shared/coding-contracts").CodeAck) => void;
  const held = new Promise<import("../shared/coding-contracts").CodeAck>(
    (r) => {
      release = r;
    },
  );
  const local = vi.spyOn(journal, "intent").mockImplementation(() => held);
  const s = await setup();
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const value = {
    binding: context(view).binding,
    operation_id: "op",
    effect_id: "effect",
    ordinal: 0,
    scope: "code.create" as const,
    target: "index.html" as const,
    expected_hash: "a".repeat(64),
  };
  const first = s.client.recordIntent(journal, value),
    second = s.client.recordIntent(journal, {
      ...value,
      operation_id: "other",
    });
  first.catch(() => {});
  second.catch(() => {});
  try {
    expect(local).toHaveBeenCalledTimes(1);
  } finally {
    await s.client.close();
    release({
      operation_id: "op",
      effect_id: "effect",
      status: "recorded",
      recorded_hash: "a".repeat(64),
    });
    await Promise.allSettled([first, second]);
  }
});

it("correlates a core acknowledgement by binding values rather than JSON key order", async () => {
  const { EffectJournal, intentProjection, journalHash } =
    await import("../../extension/src/journal");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp("/private/tmp/sage-ack-order-");
  const journal = new EffectJournal(pathToFileURL(root));
  const s = await setup(true, async (data) => {
    if (data.kind !== "journal.intent") throw Error("Unexpected");
    await s.host.send({
      kind: "journal.ack",
      binding: Object.fromEntries(
        Object.entries(data.binding).reverse(),
      ) as unknown as import("../shared/coding-contracts").CodeBinding,
      payload: {
        operation_id: data.payload.operation_id,
        effect_id: data.payload.effect_id,
        status: "recorded",
        recorded_hash: journalHash(intentProjection(data.payload)),
      },
    });
  });
  try {
    await s.host.confirm(s.view.pair_id);
    const view = await s.pairing;
    expect(
      (
        await s.client.recordIntent(journal, {
          binding: context(view).binding,
          operation_id: "op",
          effect_id: "effect",
          ordinal: 0,
          scope: "code.create",
          target: "index.html",
          expected_hash: "a".repeat(64),
        })
      ).status,
    ).toBe("recorded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("durably records observation before dispatching it to the core consumer", async () => {
  const { EffectJournal, receiptProjection, journalHash } =
    await import("../../extension/src/journal");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp("/private/tmp/sage-observed-before-core-");
  const journal = new EffectJournal(pathToFileURL(root));
  let calls = 0;
  const s = await setup(true, async (data) => {
    if (data.kind !== "journal.observed") throw Error("Unexpected");
    calls++;
    expect(
      (await journal.get(data.payload.operation_id)).observations,
    ).toHaveLength(1);
    await s.host.send({
      kind: "journal.ack",
      binding: data.binding,
      payload: {
        operation_id: data.payload.operation_id,
        effect_id: data.payload.effect_id,
        status: "recorded",
        recorded_hash: journalHash(receiptProjection(data.payload)),
      },
    });
  });
  try {
    await s.host.confirm(s.view.pair_id);
    const view = await s.pairing;
    const value = {
      binding: context(view).binding,
      operation_id: "op",
      effect_id: "effect",
      ordinal: 0,
      scope: "code.create" as const,
      target: "index.html" as const,
      expected_hash: "a".repeat(64),
    };
    await journal.intent(value);
    expect(
      (await s.client.recordObserved(journal, { ...value, status: "created" }))
        .status,
    ).toBe("recorded");
    expect(calls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("routes authenticated coding controls once, polls source-free status and drops late replies on close", async () => {
  const controls: CodingControlInput[] = [];
  const received: BridgeData[] = [];
  const closed = vi.fn();
  let release: (() => void) | undefined;
  let hold = false;
  let ready = false;
  const template = {
    ...corpus.cases.find((row) => row.kind === "job_view" && row.valid)!.value,
    expires_at: new Date(capturedAt + 1800000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  const selected: {
    binding?: Extract<BridgeData, { kind: "context.offer" }>["binding"];
  } = {};
  let polls = 0;
  const observer = vi.fn();
  const s = await setup(true, observer, {
    onClose: closed,
    codingControl: async (input) => {
      controls.push(input);
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const result =
        input.operation === "revoke_pair"
          ? { status: "revoked" }
          : input.operation === "proposal_get"
            ? makeProposal()
            : parseCodeJobView({ ...template, binding: selected.binding });
      return {
        version: 1,
        kind: "host_coding_reply",
        id: "trusted",
        host_boot_id: "b".repeat(32),
        generation: controls.length,
        operation: input.operation,
        result,
      } as HostCodingReply;
    },
    codingStatus: async () => {
      polls++;
      return parseCodeJobView({
        ...template,
        binding: selected.binding,
        state: ready ? "review_required" : "proposing",
      });
    },
  });
  await s.host.confirm(s.view.pair_id);
  const paired = await s.pairing;
  const message = context(paired);
  const binding = message.binding;
  selected.binding = binding;
  s.client.onData((value) => {
    received.push(value);
  });
  await s.client.send(message);
  for (let i = 0; i < 50 && !received.length; i++) await wait(2);
  expect(controls.map((row) => row.operation)).toEqual(["context"]);
  expect(observer).not.toHaveBeenCalled();
  expect(received[0].kind).toBe("job.status");
  ready = true;
  await wait(1100);
  expect(polls).toBe(1);
  expect(received.some((row) => row.kind === "proposal.offer")).toBe(true);
  expect(s.host.codingJobStatus("job-1")?.state).toBe("review_required");
  expect(s.host.codingJobStatus("other")).toBeUndefined();
  hold = true;
  await s.client.send({
    kind: "review.decision",
    binding,
    payload: {
      binding,
      scope: "code.create",
      approved_hash: "a".repeat(64),
      decision: "accept",
    },
  });
  for (let i = 0; i < 50 && !release; i++) await wait(2);
  const old = received.length;
  hold = false;
  await s.host.revoke();
  release?.();
  await wait();
  expect(received).toHaveLength(old);
  expect(controls.at(-1)?.operation).toBe("revoke_pair");
  expect(closed).toHaveBeenCalledTimes(1);
  expect(s.host.codingJobStatus("job-1")).toBeUndefined();
  await s.host.close();
  expect(closed).toHaveBeenCalledTimes(1);
});

it("routes only fixed review/test/journal/finish kinds and keeps fresh ack correlation", async () => {
  const { EffectJournal, journalHash, intentProjection, receiptProjection } =
    await import("../../extension/src/journal");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp("/private/tmp/sage-task5-journal-");
  resources.push({ close: () => rm(root, { recursive: true, force: true }) });
  const journal = new EffectJournal(pathToFileURL(root));
  const controls: string[] = [];
  const received: BridgeData[] = [];
  const selected: {
    binding?: Extract<BridgeData, { kind: "context.offer" }>["binding"];
  } = {};
  const good = (kind: string) =>
    corpus.cases.find((row) => row.kind === kind && row.valid)!.value;
  const template = {
    ...good("job_view"),
    expires_at: new Date(capturedAt + 1800000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  const s = await setup(true, () => {}, {
    codingControl: async (input) => {
      controls.push(input.operation);
      const binding = selected.binding!;
      const job = parseCodeJobView({ ...template, binding });
      const result =
        input.operation === "revoke_pair"
          ? { status: "revoked" }
          : input.operation === "review"
            ? { kind: "job", job }
            : input.operation === "intent" || input.operation === "observation"
              ? {
                  operation_id: input.params.operation_id,
                  effect_id: input.params.effect_id,
                  status: "recorded",
                  recorded_hash: journalHash(
                    input.operation === "intent"
                      ? intentProjection(input.params)
                      : receiptProjection(input.params),
                  ),
                }
              : job;
      return {
        version: 1,
        kind: "host_coding_reply",
        id: "trusted",
        host_boot_id: "b".repeat(32),
        generation: controls.length,
        operation: input.operation,
        result,
      } as HostCodingReply;
    },
  });
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const message = context(view),
    binding = message.binding;
  selected.binding = binding;
  s.client.onData((value) => {
    received.push(value);
  });
  await s.client.send(message);
  await wait();
  await s.client.send({
    kind: "review.decision",
    binding,
    payload: {
      binding,
      scope: "code.create",
      decision: "reject",
      approved_hash: "a".repeat(64),
    },
  });
  expect(
    (
      await s.client.recordIntent(journal, {
        ...good("intent"),
        binding,
      } as never)
    ).status,
  ).toBe("recorded");
  expect(
    (
      await s.client.recordObserved(journal, {
        ...good("receipt"),
        binding,
      } as never)
    ).status,
  ).toBe("recorded");
  await s.client.send({
    kind: "test.preview",
    binding,
    payload: { ...good("recipe"), root_id: binding.root_id } as never,
  });
  await wait();
  await s.client.send({ kind: "result.dismissed", binding, payload: null });
  await wait();
  expect(controls).toEqual([
    "context",
    "review",
    "intent",
    "observation",
    "test_prepare",
    "finish",
  ]);
  expect(received.map((row) => row.kind)).toEqual([
    "job.status",
    "grant.reply",
    "job.status",
    "job.status",
  ]);
  await s.host.revoke();
});

it("closes the owned listener even when the lifecycle observer rejects", async () => {
  const s = await setup(true, () => {}, {
    onClose: async () => {
      throw Error("fixed observer failure");
    },
  });
  await s.host.confirm(s.view.pair_id);
  await s.pairing;
  const listener = (s.host as unknown as { server: import("node:net").Server })
    .server;
  try {
    await expect(s.host.revoke()).rejects.toThrow("fixed observer failure");
    expect(listener.listening).toBe(false);
  } finally {
    if (listener.listening)
      await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

/** Ownership-unit harness: actual host methods, injected capabilities, no transport attestation claim. */
function pollOwnerHarness(
  status: (id: string) => Promise<ReturnType<typeof parseCodeJobView>>,
  proposal?: (id: string) => Promise<unknown>,
) {
  const view: PairView = {
    ...workspace,
    host_boot_id: "b".repeat(32),
    pair_id: "pair-1",
    root_id: rootIdentity(workspace),
    challenge: "synthetic",
    status: "paired",
  };
  const sent: BridgeData[] = [];
  const session = {
    paired: true,
    send: async (value: BridgeData) => {
      sent.push(value);
    },
    close: vi.fn(),
  };
  const template = {
    ...corpus.cases.find((row) => row.kind === "job_view" && row.valid)!.value,
    expires_at: new Date(capturedAt + 1800000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
  };
  const message = (id: string) => {
    const original = context(view) as Extract<
      BridgeData,
      { kind: "context.offer" }
    >;
    const binding = { ...original.binding, job_id: id };
    return {
      ...original,
      binding,
      payload: {
        ...original.payload,
        context: { ...original.payload.context, binding },
      },
    };
  };
  const job = (id: string, state = "context_ready") =>
    parseCodeJobView({ ...template, binding: message(id).binding, state });
  const host = new EditorBridgeHost({
    onData: () => {},
    onPair: () => {},
    codingStatus: status,
    codingControl: async (input) => {
      const id =
        input.operation === "context"
          ? input.params.context.binding.job_id
          : input.operation === "proposal_get" || input.operation === "finish"
            ? input.params.job_id
            : "unused";
      const result =
        input.operation === "revoke_pair"
          ? { status: "revoked" }
          : input.operation === "proposal_get"
            ? await (proposal?.(id) ??
                Promise.resolve(makeProposal({ job_id: id })))
            : job(
                id,
                input.operation === "finish" ? "completed" : "context_ready",
              );
      return {
        version: 1,
        kind: "host_coding_reply",
        id: "control",
        host_boot_id: "c".repeat(32),
        generation: 1,
        operation: input.operation,
        result,
      } as HostCodingReply;
    },
  });
  const owner = host as unknown as {
    session: unknown;
    view: PairView;
    epoch: number;
    receive: (value: BridgeData, s: unknown, v: PairView) => Promise<void>;
    poll: (s: unknown, v: PairView, e: number) => void;
  };
  Object.assign(owner, { session, view, epoch: 1 });
  return {
    host,
    session,
    sent,
    job,
    accept: (id: string) => owner.receive(message(id), session, view),
    finish: (id: string) =>
      owner.receive(
        {
          kind: "result.dismissed",
          binding: message(id).binding,
          payload: null,
        },
        session,
        view,
      ),
    refresh: () => owner.poll(session, view, 1),
  };
}

it.each(["completed", "review_required", "failure"])(
  "poll owner discards stale %s status after same-pair replacement",
  async (state) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: (value: ReturnType<typeof parseCodeJobView>) => void,
      reject!: (reason: Error) => void;
    const held = new Promise<ReturnType<typeof parseCodeJobView>>(
      (resolve, fail) => {
        release = resolve;
        reject = fail;
      },
    );
    const proposal = vi.fn(async () => {
      throw Error("obsolete proposal");
    });
    const h = pollOwnerHarness(
      async (id) => (id === "job-1" ? held : h.job(id, "proposing")),
      proposal,
    );
    try {
      await h.accept("job-1");
      await vi.advanceTimersByTimeAsync(1000);
      await h.finish("job-1");
      await h.accept("job-2");
      if (state === "failure") reject(Error("obsolete status"));
      else release(h.job("job-1", state));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.host.codingJobStatus("job-2")?.binding.job_id).toBe("job-2");
      expect(
        h.sent.filter(
          (value) => "binding" in value && value.binding.job_id === "job-1",
        ),
      ).toHaveLength(2);
      expect(proposal).not.toHaveBeenCalled();
      expect(h.session.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.host.codingJobStatus("job-2")?.state).toBe("proposing");
    } finally {
      release(h.job("job-1", "completed"));
      await vi.advanceTimersByTimeAsync(0);
      await h.host.close();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "old proposal completion cannot affect the replacement owner (reject=%s)",
  async (fails) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: (value: unknown) => void, reject!: (reason: Error) => void;
    const held = new Promise<unknown>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    const h = pollOwnerHarness(
      async (id) => h.job(id, "review_required"),
      async () => held,
    );
    try {
      await h.accept("job-1");
      await vi.advanceTimersByTimeAsync(1000);
      await h.finish("job-1");
      await h.accept("job-2");
      if (fails) reject(Error("obsolete proposal"));
      else release(makeProposal());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.close).not.toHaveBeenCalled();
      expect(h.sent.filter((value) => value.kind === "proposal.offer")).toEqual(
        [],
      );
      expect(h.host.codingJobStatus("job-2")?.binding.job_id).toBe("job-2");
    } finally {
      release(makeProposal());
      await vi.advanceTimersByTimeAsync(0);
      await h.host.close();
      vi.useRealTimers();
    }
  },
);

it("keeps one status request across same-job refresh and replacement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let release!: (value: ReturnType<typeof parseCodeJobView>) => void;
  const held = new Promise<ReturnType<typeof parseCodeJobView>>((resolve) => {
    release = resolve;
  });
  let active = 0,
    maximum = 0;
  const requests: string[] = [];
  const h = pollOwnerHarness(async (id) => {
    requests.push(id);
    active++;
    maximum = Math.max(maximum, active);
    try {
      return id === "job-1" ? await held : h.job(id, "proposing");
    } finally {
      active--;
    }
  });
  try {
    await h.accept("job-1");
    await vi.advanceTimersByTimeAsync(1000);
    h.refresh();
    h.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toEqual(["job-1"]);
    await h.finish("job-1");
    await h.accept("job-2");
    await vi.advanceTimersByTimeAsync(2000);
    expect(requests).toEqual(["job-1"]);
    release(h.job("job-1", "completed"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toEqual(["job-1", "job-2"]);
    expect(maximum).toBe(1);
  } finally {
    release(h.job("job-1", "completed"));
    await vi.advanceTimersByTimeAsync(0);
    await h.host.close();
    vi.useRealTimers();
  }
});

it.each(["job.status", "proposal.offer"] as const)(
  "old %s send completion cannot mutate the next poll owner",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proposals: string[] = [];
    const h = pollOwnerHarness(
      async (id) => h.job(id, "review_required"),
      async (id) => {
        proposals.push(id);
        return makeProposal({ job_id: id });
      },
    );
    const send = h.session.send;
    let blocked = false;
    h.session.send = async (value) => {
      if (
        !blocked &&
        "binding" in value &&
        value.binding.job_id === "job-1" &&
        value.kind === kind &&
        (value.kind !== "job.status" ||
          value.payload.state === "review_required")
      ) {
        blocked = true;
        await held;
      }
      await send(value);
    };
    try {
      await h.accept("job-1");
      await vi.advanceTimersByTimeAsync(1000);
      expect(blocked).toBe(true);
      await h.finish("job-1");
      await h.accept("job-2");
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.host.codingJobStatus("job-2")?.binding.job_id).toBe("job-2");
      if (kind === "job.status") expect(proposals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(proposals).toContain("job-2");
      expect(h.session.close).not.toHaveBeenCalled();
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
      await h.host.close();
      vi.useRealTimers();
    }
  },
);

it("publishes cloned source-free metadata, snapshots current pair, and clears original-lease ownership synchronously", async () => {
  const statuses: ReturnType<typeof parseCodeJobView>[] = [];
  const closes: PairView[] = [];
  const template = corpus.cases.find(
    (row) => row.kind === "job_view" && row.valid,
  )!.value;
  const s = await setup(
    true,
    () => {
      throw Error("raw observer must not run");
    },
    {
      onJobStatus: (job) => {
        statuses.push(job);
      },
      onClose: (view) => {
        if (view) closes.push(view);
      },
      codingControl: async (input) =>
        ({
          version: 1,
          kind: "host_coding_reply",
          id: "control",
          host_boot_id: "host-1",
          generation: 1,
          operation: input.operation,
          result:
            input.operation === "context"
              ? {
                  ...template,
                  binding: input.params.context.binding,
                  expires_at: new Date(input.params.expires_at_ms)
                    .toISOString()
                    .replace(/\.\d{3}Z$/, "Z"),
                }
              : { status: "revoked" },
        }) as HostCodingReply,
    },
  );
  expect(s.host.pairingAvailable()).toBe(true);
  expect(s.host.pairView()?.status).toBe("awaiting_confirmation");
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  expect(s.host.pairView()?.status).toBe("paired");
  const offered = context(view) as Extract<
    BridgeData,
    { kind: "context.offer" }
  >;
  await s.client.send(offered);
  await vi.waitFor(() => expect(statuses).toHaveLength(1));
  const snapshot = s.host.currentCodingJob()!;
  expect(snapshot.binding).toEqual(offered.binding);
  (snapshot.binding as { pair_id: string }).pair_id = "mutated";
  expect(s.host.codingJobStatus(offered.binding.job_id)?.binding.pair_id).toBe(
    view.pair_id,
  );
  const closed = s.host.close();
  expect(s.host.currentCodingJob()).toBeUndefined();
  expect(s.host.pairView()).toBeNull();
  expect(closes).toHaveLength(1);
  await closed;
});
it("cache reads reject clock rollback and never renew an original source expiry", async () => {
  vi.useFakeTimers();
  const h = pollOwnerHarness(async () => h.job("old"));
  await h.accept("old");
  const snapshot = h.host.currentCodingJob();
  expect(snapshot).toBeDefined();
  vi.setSystemTime(Date.now() - 1);
  expect(h.host.currentCodingJob()).toBeUndefined();
  await h.host.close();
  vi.useRealTimers();
});
it("still closes the listener when a close notification throws synchronously", async () => {
  const s = await setup(true, () => {}, {
    onClose: () => {
      throw Error("synthetic observer");
    },
  });
  await s.host.confirm(s.view.pair_id);
  await s.pairing;
  const server = (s.host as unknown as { server: import("node:net").Server })
    .server;
  await expect(s.host.close()).rejects.toThrow("synthetic observer");
  expect(server.listening).toBe(false);
});

it("accepts source-free historical list requests under the fresh pair without a fabricated binding", () => {
  const view: PairView = {
    ...workspace,
    host_boot_id: "fresh-boot",
    pair_id: "fresh-pair",
    root_id: rootIdentity(workspace),
    challenge: "proof",
    status: "paired",
  };
  const request = {
    kind: "history.request",
    payload: { inspection_id: "random-inspection", action: "list", offset: 0 },
  };
  expect(parseBridgeData(request, "extension", view)).toEqual(request);
  expect(() => parseBridgeData(request, "host", view)).toThrow();
});

function historicalFixture(
  view: PairView,
  overrides: Record<string, unknown> = {},
) {
  return parseCodeJobView({
    ...corpus.cases.find((row) => row.kind === "job_view" && row.valid)!.value,
    binding: {
      ...BINDING,
      boot_id: "older-boot",
      pair_id: "older-pair",
      window_id: "older-window",
      root_id: view.root_id,
    },
    state: "interrupted",
    receipts: [],
    ...overrides,
  });
}
it("filters one bounded Core history page, preserving manual next and exact old receipt bindings", async () => {
  const controls = vi.fn();
  let readView: () => PairView = () => {
    throw Error("Not paired");
  };
  const reader = vi.fn(async () => {
    const view = readView();
    return {
      items: [
        historicalFixture(view),
        historicalFixture(view, {
          binding: { ...BINDING, job_id: "other-root" },
        }),
        historicalFixture(view, { state: "completed" }),
        historicalFixture(view, {
          binding: context(view).binding,
          state: "partial",
        }),
      ],
      next_offset: 20,
    };
  });
  const s = await setup(true, () => {}, {
    codingControl: controls,
    codingHistory: reader,
    codingStatus: async () => historicalFixture(readView()),
  });
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  readView = () => view;
  expect(await s.client.history({ action: "list", offset: 0 })).toMatchObject({
    action: "list",
    items: [
      { job_id: BINDING.job_id, root_id: view.root_id, state: "interrupted" },
    ],
    next_offset: 20,
  });
  expect(reader).toHaveBeenCalledTimes(1);
  expect(reader).toHaveBeenCalledWith(0);
  const reply = await s.client.history({
    action: "inspect",
    job_id: BINDING.job_id,
  });
  expect(reply.action).toBe("inspect");
  if (reply.action === "inspect")
    expect(reply.job.binding.boot_id).toBe("older-boot");
  expect(controls).not.toHaveBeenCalled();
  expect(s.host.currentCodingJob()).toBeUndefined();
});
it.each([
  "interrupted",
  "needs_reconciliation",
  "partial",
  "applied_unsaved",
  "needs_review",
])(
  "supports only historical eligible %s on this authenticated root",
  async (state) => {
    const s = await setup();
    await s.host.confirm(s.view.pair_id);
    const view = await s.pairing;
    const message = {
      kind: "history.reply",
      payload: {
        inspection_id: "id",
        action: "inspect",
        job: historicalFixture(view, { state }),
      },
    };
    expect(parseBridgeData(message, "host", view)).toMatchObject(message);
    expect(() =>
      parseBridgeData(
        { ...message, binding: context(view).binding },
        "host",
        view,
      ),
    ).toThrow();
    expect(() => parseBridgeData(message, "extension", view)).toThrow();
    const job = message.payload.job;
    for (const wrong of [
      { ...job, binding: { ...job.binding, root_id: "other" } },
      {
        ...job,
        receipts: [
          { ...makeReceipt(), binding: { ...job.binding, boot_id: "forged" } },
        ],
      },
      { ...job, state: "testing" },
      { ...job, binding: context(view).binding },
    ])
      expect(() =>
        parseBridgeData(
          { ...message, payload: { ...message.payload, job: wrong } },
          "host",
          view,
        ),
      ).toThrow();
  },
);
it("delayed history read leaves ordinary intent ACK progress and current owner untouched", async () => {
  const { EffectJournal, journalHash, intentProjection } =
    await import("../../extension/src/journal");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp("/private/tmp/sage-history-ack-");
  let resume!: (job: ReturnType<typeof historicalFixture>) => void,
    reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const read = new Promise<ReturnType<typeof historicalFixture>>((resolve) => {
    resume = resolve;
  });
  const control = vi.fn(async (input: CodingControlInput) => {
    if (input.operation === "revoke_pair")
      return {
        operation: "revoke_pair",
        result: { status: "revoked" },
      } as HostCodingReply;
    if (input.operation !== "intent") throw Error("Only intent allowed");
    return {
      operation: "intent",
      result: {
        operation_id: input.params.operation_id,
        effect_id: input.params.effect_id,
        status: "recorded",
        recorded_hash: journalHash(intentProjection(input.params)),
      },
    } as HostCodingReply;
  });
  const s = await setup(true, () => {}, {
    codingControl: control,
    codingStatus: async () => {
      reached();
      return read;
    },
  });
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const history = s.client.history({
    action: "inspect",
    job_id: BINDING.job_id,
  });
  try {
    await ready;
    const ack = await s.client.recordIntent(
      new EffectJournal(pathToFileURL(root)),
      {
        binding: context(view).binding,
        scope: "code.create",
        operation_id: "live-op",
        effect_id: "live-effect",
        ordinal: 0,
        target: "index.html",
        expected_hash: "a".repeat(64),
      },
    );
    expect(ack.status).toBe("recorded");
    expect(control).toHaveBeenCalledTimes(1);
    expect(s.host.currentCodingJob()).toBeUndefined();
  } finally {
    resume(historicalFixture(view));
    await history;
    await rm(root, { recursive: true, force: true });
  }
});
it("history checkpoint refuses host concurrency before the first request settles", async () => {
  let finish!: (page: { items: never[]; next_offset: null }) => void;
  const held = new Promise<{ items: never[]; next_offset: null }>((resolve) => {
    finish = resolve;
  });
  const reads: number[] = [];
  const s = await setup(true, () => {}, {
    codingHistory: async (offset) => {
      reads.push(offset);
      return held;
    },
  });
  await s.host.confirm(s.view.pair_id);
  await s.pairing;
  try {
    const pending = s.client.history({ action: "list", offset: 0 });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(reads).toEqual([0]));
    await s.client.send({
      kind: "history.request",
      payload: { inspection_id: "concurrent", action: "list", offset: 20 },
    });
    await rejected;
    expect(reads).toEqual([0]);
  } finally {
    finish({ items: [], next_offset: null });
  }
});
it.each([
  ["resolve", false],
  ["reject", false],
  ["resolve", true],
  ["reject", true],
] as const)(
  "history checkpoint releases timeout A after late A %s; concurrent refusal %s",
  async (completion, concurrent) => {
    let now = Date.now();
    let resolveA!: (page: { items: never[]; next_offset: null }) => void,
      rejectA!: (error: Error) => void,
      resolveB!: (page: { items: never[]; next_offset: null }) => void;
    const heldA = new Promise<{ items: never[]; next_offset: null }>(
      (resolve, reject) => {
        resolveA = resolve;
        rejectA = reject;
      },
    );
    const heldB = new Promise<{ items: never[]; next_offset: null }>(
      (resolve) => {
        resolveB = resolve;
      },
    );
    const reads: number[] = [];
    const effects: BridgeData[] = [];
    const control = vi.fn();
    const s = await setup(
      true,
      (message) => {
        effects.push(message);
      },
      {
        now: () => now,
        codingControl: control,
        codingHistory: async (offset) => {
          reads.push(offset);
          return offset === 0
            ? heldA
            : offset === 20
              ? heldB
              : { items: [], next_offset: null };
        },
      },
    );
    await s.host.confirm(s.view.pair_id);
    await s.pairing;
    const realTimeout = globalThis.setTimeout;
    const timers: {
      callback: () => void;
      handle: ReturnType<typeof setTimeout>;
    }[] = [];
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        const handle = realTimeout(callback, delay, ...args);
        if (delay === 30000)
          timers.push({
            callback: () => {
              callback(...args);
            },
            handle,
          });
        return handle;
      });
    try {
      const a = s.client.history({ action: "list", offset: 0 });
      await vi.waitFor(() => expect(reads).toEqual([0]));
      // Client installs its own deadline first; fire only the host's timer.
      expect(timers).toHaveLength(2);
      now += 30000;
      clearTimeout(timers[1].handle);
      timers[1].callback();
      expect(await a).toMatchObject({ action: "unavailable" });
      const b = s.client.history({ action: "list", offset: 20 });
      const bResult = b.then(
        (reply) => reply,
        () => "pair closed",
      );
      await vi.waitFor(() => expect(reads).toEqual([0, 20]));
      if (completion === "resolve") resolveA({ items: [], next_offset: null });
      else rejectA(Error("Late unavailable backend"));
      await wait();
      expect(effects).toEqual([]);
      expect(control).not.toHaveBeenCalled();
      expect(s.host.currentCodingJob()).toBeUndefined();
      expect(() => s.client.history({ action: "list", offset: 40 })).toThrow();
      if (concurrent) {
        // A's finally must not release B's host owner.
        await s.client.send({
          kind: "history.request",
          payload: { inspection_id: "concurrent", action: "list", offset: 40 },
        });
        expect(await bResult).toBe("pair closed");
        expect(reads).toEqual([0, 20]);
        return;
      }
      resolveB({ items: [], next_offset: null });
      expect(await bResult).toMatchObject({
        action: "list",
        items: [],
        next_offset: null,
      });
      expect(
        await s.client.history({ action: "list", offset: 40 }),
      ).toMatchObject({ action: "list" });
      expect(reads).toEqual([0, 20, 40]);
      expect(effects).toEqual([]);
      expect(control).not.toHaveBeenCalled();
      expect(s.host.currentCodingJob()).toBeUndefined();
    } finally {
      resolveA({ items: [], next_offset: null });
      resolveB({ items: [], next_offset: null });
      timers.forEach(({ handle }) => clearTimeout(handle));
      spy.mockRestore();
    }
  },
);
it("pair loss rejects a pending historical inspection and ignores its late completion", async () => {
  let resume!: (job: ReturnType<typeof historicalFixture>) => void;
  const held = new Promise<ReturnType<typeof historicalFixture>>((resolve) => {
    resume = resolve;
  });
  const s = await setup(true, () => {}, { codingStatus: () => held });
  await s.host.confirm(s.view.pair_id);
  const view = await s.pairing;
  const pending = s.client.history({
    action: "inspect",
    job_id: BINDING.job_id,
  });
  const rejected = expect(pending).rejects.toThrow();
  await wait();
  await s.host.close();
  await rejected;
  resume(historicalFixture(view));
  await wait();
  expect(s.host.currentCodingJob()).toBeUndefined();
});
it.each([-1, 1.5, 1000001, Number.MAX_SAFE_INTEGER])(
  "rejects history offset %s and unsolicited binding fields",
  (offset) => {
    const view: PairView = {
      ...workspace,
      host_boot_id: "boot",
      pair_id: "pair",
      root_id: rootIdentity(workspace),
      challenge: "proof",
      status: "paired",
    };
    expect(() =>
      parseBridgeData(
        {
          kind: "history.request",
          payload: { inspection_id: "id", action: "list", offset },
        },
        "extension",
        view,
      ),
    ).toThrow();
  },
);
