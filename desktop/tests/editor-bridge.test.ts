import {
  parseCodeJobView,
  type CodingControlInput,
  type HostCodingReply,
} from "../shared/coding-contracts";
import { makeProposal } from "./coding-fixtures";
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
function context(view: PairView): BridgeData {
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
function selectedContext(view: PairView): BridgeData {
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
    const value = data as BridgeData;
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
  const template = corpus.cases.find(
    (row) => row.kind === "job_view" && row.valid,
  )!.value;
  const selected: { binding?: BridgeData["binding"] } = {};
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
  const selected: { binding?: BridgeData["binding"] } = {};
  const good = (kind: string) =>
    corpus.cases.find((row) => row.kind === kind && row.valid)!.value;
  const template = good("job_view");
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
