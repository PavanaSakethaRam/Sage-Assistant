/** Explicit one-shot connection. Never reconnect or release data before mutual confirmation. */
import { connect } from "node:net";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { requireFreshAcks, type EffectJournal } from "./journal";
import {
  parseCodeIntent,
  parseCodeReceipt,
  type CodeAck,
  type CodeIntent,
  type CodeReceipt,
} from "../../desktop/shared/coding-contracts";
import {
  BridgeSession,
  FramedPeer,
  challenge,
  clientProof,
  deriveKey,
  exact,
  hostProof,
  initialTranscript,
  workspaceCommitment,
  identifier,
  invalid,
  nonce,
  parseTicket,
  parseWorkspace,
  sameBinding,
  rootIdentity,
  transcript,
  verifyProof,
  type BridgeData,
  type LocalWorkspace,
  type PairView,
  type HistoryRequest,
  type HistoryReply,
} from "../../desktop/shared/editor-bridge";
type Options = {
  confirm: (view: PairView) => Promise<boolean>;
  guard?: () => void;
  onClose?: () => void;
  random?: (size: number) => Buffer;
};
export class ExtensionBridge {
  private peer: FramedPeer | undefined;
  private session: BridgeSession | undefined;
  private recording = false;
  private pendingHistory:
    | {
        request: HistoryRequest;
        session: BridgeSession;
        started: number;
        resolve: (value: HistoryReply) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private pendingAck:
    | {
        binding: CodeIntent["binding"];
        local: CodeAck;
        resolve: (value: CodeAck) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private handlers = new Set<(message: BridgeData) => void | Promise<void>>();
  constructor(private readonly options: Options) {}
  private check(): void {
    try {
      this.options.guard?.();
    } catch {
      this.peer?.close();
      invalid();
    }
  }
  async pair(ticket: string, workspace: LocalWorkspace): Promise<PairView> {
    this.check();
    if (this.peer || this.recording) invalid();
    parseWorkspace(workspace);
    let parsed: ReturnType<typeof parseTicket> | undefined =
      parseTicket(ticket);
    const port = parsed.port,
      boot = parsed.host_boot_id,
      secret = nonce(parsed.secret),
      client = (this.options.random ?? randomBytes)(32);
    const commitment = workspaceCommitment(secret, workspace, client);
    parsed = undefined;
    ticket = "";
    const socket = connect({ host: "127.0.0.1", port });
    const peer = new FramedPeer(socket);
    this.peer = peer;
    peer.setDeadline(10_000);
    try {
      return await new Promise<PairView>((resolve, reject) => {
        peer.onClose(() => {
          secret.fill(0);
          if (this.peer === peer) {
            this.peer = undefined;
            this.session = undefined;
          }
          this.rejectAck();
          this.rejectHistory();
          this.options.onClose?.();
          reject(new Error("Editor bridge closed"));
        });
        peer.handler = async (frame) => {
          this.check();
          const row = exact(frame, [
            "version",
            "kind",
            "server_nonce",
            "pair_id",
            "proof",
          ]);
          if (row.version !== 1 || row.kind !== "challenge") invalid();
          identifier(row.pair_id);
          const server = nonce(row.server_nonce);
          verifyProof(
            hostProof(
              secret,
              initialTranscript(
                port,
                boot,
                row.pair_id,
                client,
                server,
                commitment,
              ),
            ),
            row.proof,
          );
          let view: PairView = {
            ...workspace,
            host_boot_id: boot,
            pair_id: row.pair_id,
            root_id: rootIdentity(workspace),
            challenge: "",
            status: "awaiting_confirmation",
          };
          const bytes = transcript(view, client, server, port, commitment);
          view = { ...view, challenge: challenge(bytes) };
          const proof = clientProof(secret, bytes),
            key = deriveKey(secret, client, server);
          secret.fill(0);
          const session = new BridgeSession(
            peer,
            key,
            "extension",
            view,
            async (data) => {
              if (data.kind === "history.reply") {
                const pending = this.pendingHistory;
                const reply = data.payload;
                if (
                  !pending ||
                  pending.session !== this.session ||
                  reply.inspection_id !== pending.request.inspection_id ||
                  Date.now() < pending.started ||
                  Date.now() - pending.started >= 30000 ||
                  (reply.action !== "unavailable" &&
                    reply.action !== pending.request.action) ||
                  (reply.action === "inspect" &&
                    (pending.request.action !== "inspect" ||
                      reply.job.binding.job_id !== pending.request.job_id))
                )
                  invalid();
                this.pendingHistory = undefined;
                clearTimeout(pending.timer);
                pending.resolve(reply);
                return;
              }
              if (data.kind === "journal.ack") {
                const pending = this.pendingAck;
                if (!pending || !sameBinding(pending.binding, data.binding))
                  invalid();
                requireFreshAcks(pending.local, data.payload);
                clearTimeout(pending.timer);
                this.pendingAck = undefined;
                pending.resolve(data.payload);
                return;
              }
              for (const handler of this.handlers) {
                this.check();
                await handler(data);
              }
            },
            () => this.check(),
          );
          this.session = session;
          peer.setDeadline(60_000);
          await peer.write({
            version: 1,
            kind: "authenticate",
            workspace,
            proof,
          });
          // Do not hold the serial receive pump while the user reviews or host confirms.
          void (async () => {
            if (!(await this.options.confirm(view))) invalid();
            this.check();
            resolve(await session.confirm());
          })().catch(() => peer.close());
        };
        socket.once("connect", () => {
          void peer
            .write({
              version: 1,
              kind: "hello",
              host_boot_id: boot,
              client_nonce: client.toString("base64url"),
              workspace_commitment: commitment,
            })
            .catch(() => peer.close());
        });
      });
    } catch (error) {
      peer.close();
      throw error;
    }
  }
  private rejectAck(): void {
    const pending = this.pendingAck;
    this.pendingAck = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error("Journal reconciliation required"));
    }
  }
  private async record(
    journal: EffectJournal,
    value: CodeIntent | CodeReceipt,
    observed: boolean,
  ): Promise<CodeAck> {
    // Observations are facts about a preexisting intent, even after disconnect.
    if (!observed) this.check();
    if ((!observed && !this.session) || this.pendingAck || this.recording)
      invalid();
    const valid = observed
      ? parseCodeReceipt(JSON.parse(JSON.stringify(value)))
      : parseCodeIntent(JSON.parse(JSON.stringify(value)));
    this.recording = true;
    try {
      const local = observed
        ? await journal.observed(valid as CodeReceipt)
        : await journal.intent(valid as CodeIntent);
      this.check();
      if (local.status !== "recorded" || !this.session) invalid();
      return await new Promise<CodeAck>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.rejectAck();
          void this.close();
        }, 30000);
        this.pendingAck = {
          binding: valid.binding,
          local,
          resolve,
          reject,
          timer,
        };
        const message: BridgeData = observed
          ? {
              kind: "journal.observed",
              binding: valid.binding,
              payload: valid as CodeReceipt,
            }
          : {
              kind: "journal.intent",
              binding: valid.binding,
              payload: valid as CodeIntent,
            };
        void this.send(message).catch(() => {
          this.rejectAck();
          void this.close();
        });
      });
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.recording = false;
    }
  }
  recordIntent(journal: EffectJournal, value: CodeIntent): Promise<CodeAck> {
    return this.record(journal, value, false);
  }
  recordObserved(journal: EffectJournal, value: CodeReceipt): Promise<CodeAck> {
    return this.record(journal, value, true);
  }
  private rejectHistory(): void {
    const pending = this.pendingHistory;
    this.pendingHistory = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(Error("Historical inspection unavailable"));
    }
  }
  history(
    request:
      | { action: "list"; offset: number }
      | { action: "inspect"; job_id: string },
  ): Promise<HistoryReply> {
    this.check();
    if (!this.session || this.pendingHistory) invalid();
    const session = this.session;
    const payload: HistoryRequest = {
      ...request,
      inspection_id: randomBytes(16).toString("hex"),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.rejectHistory(), 30000);
      this.pendingHistory = {
        request: payload,
        session,
        started: Date.now(),
        resolve,
        reject,
        timer,
      };
      void this.send({ kind: "history.request", payload }).catch(() =>
        this.rejectHistory(),
      );
    });
  }
  async send(message: BridgeData): Promise<void> {
    this.check();
    if (!this.session) invalid();
    await this.session.send(message);
  }
  onData(handler: (message: BridgeData) => void | Promise<void>): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async close(): Promise<void> {
    this.rejectAck();
    this.rejectHistory();
    this.peer?.close();
    this.peer = undefined;
    this.session = undefined;
    this.handlers.clear();
  }
}

export type WorkspaceState = {
  trusted: boolean;
  remoteName: string | undefined;
  uiKind: "desktop" | "web";
  folders: readonly { uri: string }[];
};
export function localWorkspace(
  state: WorkspaceState,
  window_id: string,
): LocalWorkspace {
  if (
    !state.trusted ||
    state.remoteName !== undefined ||
    state.uiKind !== "desktop" ||
    state.folders.length !== 1
  )
    invalid();
  const uri = new URL(state.folders[0].uri);
  if (uri.protocol !== "file:" || uri.host || uri.search || uri.hash) invalid();
  const root = realpathSync(fileURLToPath(uri));
  const info = statSync(root, { bigint: true });
  if (!info.isDirectory()) invalid();
  return parseWorkspace({
    root_uri: pathToFileURL(root).href,
    root_file_id: `${info.dev}-${info.ino}`,
    window_id,
  });
}
