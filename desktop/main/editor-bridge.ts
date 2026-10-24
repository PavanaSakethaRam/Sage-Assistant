import {
  type CodingControlInput,
  type HostCodingReply,
  type CodeBinding,
  type CodeJobView,
  parseCodeJobView,
  parseCodeJobPage,
  type CodeJobPage,
} from "../shared/coding-contracts";
/** Loopback listener owns all ticket, key and socket references; no native-effect API. */
import { createServer, type Server } from "node:net";
import { randomBytes } from "node:crypto";
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
  invalid,
  nonce,
  parseWorkspace,
  rootIdentity,
  historicalJob,
  parseHistoricalJob,
  type HistoryRequest,
  type HistoryReply,
  transcript,
  verifyProof,
  type BridgeData,
  type PairTicket,
  type PairView,
} from "../shared/editor-bridge";
type HostOptions = {
  onData: (message: BridgeData) => void | Promise<void>;
  onPair: (view: PairView) => void;
  onClose?: (view: PairView | undefined) => void | Promise<void>;
  codingControl?: (value: CodingControlInput) => Promise<HostCodingReply>;
  onJobStatus?: (job: CodeJobView) => void;
  codingHistory?: (offset: number) => Promise<CodeJobPage>;
  codingStatus?: (jobId: string) => Promise<CodeJobView>;
  now?: () => number;
  random?: (size: number) => Buffer;
};
export class EditorBridgeHost {
  private readonly random: (size: number) => Buffer;
  private readonly now: () => number;
  private readonly boot: string;
  private server: Server | undefined;
  private secret: Buffer | undefined;
  private peers = new Set<FramedPeer>();
  private session: BridgeSession | undefined;
  private view: PairView | undefined;
  private issued = 0;
  private last = 0;
  private expires = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private historyTask: object | undefined;
  private polling: ReturnType<typeof setTimeout> | undefined;
  private activeBinding: CodeBinding | undefined;
  private epoch = 0;
  private contextExpires = 0;
  private contextTimer: ReturnType<typeof setTimeout> | undefined;
  private latestJob: CodeJobView | undefined;
  private offeredRevision = 0;
  private pollOwner = 0;
  private pollInFlight = false;
  private revoking = false;
  private closingPair: Promise<void> | undefined;
  constructor(private readonly options: HostOptions) {
    this.random = options.random ?? randomBytes;
    this.now = options.now ?? Date.now;
    this.boot = this.random(16).toString("hex");
  }
  private checkClock(): void {
    const time = this.now();
    if (!Number.isFinite(time) || time < this.last || time >= this.expires)
      invalid();
    this.last = time;
  }
  async start(): Promise<PairTicket> {
    if (this.closed || this.server) invalid();
    this.issued = this.now();
    this.last = this.issued;
    this.expires = this.issued + 60_000;
    if (!Number.isFinite(this.issued)) invalid();
    this.secret = this.random(32);
    const server = createServer((socket) => {
      if (this.session || this.peers.size >= 2) {
        socket.destroy();
        return;
      }
      const peer = new FramedPeer(socket);
      this.peers.add(peer);
      peer.setDeadline(Math.min(10_000, this.expires - this.now()));
      peer.onClose(() => {
        this.peers.delete(peer);
        if (this.session?.peer === peer) void this.revoke().catch(() => {});
      });
      let pending:
        | {
            client: Buffer;
            server: Buffer;
            pair_id: string;
            commitment: string;
            port: number;
          }
        | undefined;
      peer.handler = async (frame) => {
        this.checkClock();
        if (!this.secret) invalid();
        if (!pending) {
          const hello = exact(frame, [
            "version",
            "kind",
            "host_boot_id",
            "client_nonce",
            "workspace_commitment",
          ]);
          if (
            hello.version !== 1 ||
            hello.kind !== "hello" ||
            hello.host_boot_id !== this.boot
          )
            invalid();
          const client = nonce(hello.client_nonce),
            commitment = nonce(hello.workspace_commitment).toString(
              "base64url",
            ),
            serverNonce = this.random(32),
            pair_id = this.random(16).toString("hex");
          const address = server.address();
          if (!address || typeof address === "string") invalid();
          pending = {
            client,
            server: serverNonce,
            pair_id,
            commitment,
            port: address.port,
          };
          await peer.write({
            version: 1,
            kind: "challenge",
            server_nonce: serverNonce.toString("base64url"),
            pair_id,
            proof: hostProof(
              this.secret,
              initialTranscript(
                address.port,
                this.boot,
                pair_id,
                client,
                serverNonce,
                commitment,
              ),
            ),
          });
        } else {
          const auth = exact(frame, ["version", "kind", "workspace", "proof"]);
          if (auth.version !== 1 || auth.kind !== "authenticate") invalid();
          const workspace = parseWorkspace(auth.workspace);
          verifyProof(
            workspaceCommitment(this.secret, workspace, pending.client),
            pending.commitment,
          );
          let view: PairView = {
            ...workspace,
            host_boot_id: this.boot,
            pair_id: pending.pair_id,
            root_id: rootIdentity(workspace),
            challenge: "",
            status: "awaiting_confirmation",
          };
          const bytes = transcript(
            view,
            pending.client,
            pending.server,
            pending.port,
            pending.commitment,
          );
          view = { ...view, challenge: challenge(bytes) };
          verifyProof(clientProof(this.secret, bytes), auth.proof);
          const key = deriveKey(this.secret, pending.client, pending.server);
          this.secret.fill(0);
          this.secret = undefined;
          this.view = view;
          const session: BridgeSession = new BridgeSession(
            peer,
            key,
            "host",
            view,
            (message) => this.receive(message, session, view),
            () => {
              if (!session.paired) this.checkClock();
            },
          );
          this.session = session;
          pending = undefined;
          for (const other of this.peers) if (other !== peer) other.close();
          peer.setDeadline(this.expires - this.now());
          await session.control("control.authenticated");
          this.options.onPair(this.view);
        }
      };
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      server.on("error", () => {
        void this.revoke().catch(() => {});
      });
      const address = server.address();
      if (!address || typeof address === "string") invalid();
      this.expiry = setTimeout(() => {
        if (!this.session?.paired) void this.revoke().catch(() => {});
      }, 60_000);
      return {
        version: 1,
        port: address.port,
        host_boot_id: this.boot,
        secret: this.secret.toString("base64url"),
      };
    } catch (error) {
      await this.revoke();
      throw error;
    }
  }
  async confirm(pair_id: string): Promise<PairView> {
    if (!this.session || !this.view || pair_id !== this.view.pair_id) invalid();
    this.checkClock();
    const session = this.session;
    const paired = await session.confirm();
    if (this.session !== session) invalid();
    this.view = paired;
    return paired;
  }
  async send(message: BridgeData): Promise<void> {
    if (!this.session) invalid();
    await this.session.send(message);
  }
  private current(
    session: BridgeSession,
    view: PairView,
    epoch: number,
  ): boolean {
    return (
      this.session === session &&
      session.paired &&
      this.view?.pair_id === view.pair_id &&
      epoch === this.epoch &&
      !this.closed
    );
  }
  private async history(
    request: HistoryRequest,
    session: BridgeSession,
    view: PairView,
    epoch: number,
  ): Promise<void> {
    if (this.historyTask) invalid();
    const token = {};
    this.historyTask = token;
    const started = this.now();
    let settled = false;
    const current = () =>
      this.current(session, view, epoch) &&
      this.now() >= started &&
      this.now() - started < 30000;
    const reply = async (payload: HistoryReply) => {
      if (settled) return;
      settled = true;
      if (this.historyTask === token) this.historyTask = undefined;
      if (this.current(session, view, epoch))
        await session.send({ kind: "history.reply", payload });
    };
    const unavailable: HistoryReply = {
      inspection_id: request.inspection_id,
      action: "unavailable",
    };
    const timer = setTimeout(() => {
      void reply(unavailable).catch(() => session.close());
    }, 30000);
    try {
      if (request.action === "list") {
        if (!this.options.codingHistory) throw Error("Unavailable");
        const page = parseCodeJobPage(
          await this.options.codingHistory(request.offset),
        );
        if (!current()) return;
        if (page.items.length > 20) throw Error("Unavailable");
        const items = page.items
          .map(parseHistoricalJob)
          .filter((job) => historicalJob(job, view))
          .map((job) => ({
            job_id: job.binding.job_id,
            root_id: job.binding.root_id,
            mode: job.mode,
            state: job.state,
          }));
        await reply({
          inspection_id: request.inspection_id,
          action: "list",
          items,
          next_offset: page.next_offset,
        });
      } else {
        if (!this.options.codingStatus) throw Error("Unavailable");
        const job = parseHistoricalJob(
          await this.options.codingStatus(request.job_id),
        );
        if (!current()) return;
        if (job.binding.job_id !== request.job_id || !historicalJob(job, view))
          throw Error("Unavailable");
        await reply({
          inspection_id: request.inspection_id,
          action: "inspect",
          job,
        });
      }
    } catch {
      if (current()) await reply(unavailable);
    } finally {
      clearTimeout(timer);
      if (this.historyTask === token) this.historyTask = undefined;
    }
  }
  private async receive(
    message: BridgeData,
    session: BridgeSession,
    view: PairView,
  ): Promise<void> {
    const control = this.options.codingControl;
    const epoch = this.epoch;
    if (!this.current(session, view, epoch)) invalid();
    if (message.kind === "history.request") {
      // Release the receive pump so a delayed informational read cannot hold effect ACKs.
      void this.history(message.payload, session, view, epoch).catch(() =>
        session.close(),
      );
      return;
    }
    if (!control) {
      await this.options.onData(message);
      return;
    }
    if (message.kind === "context.offer") {
      this.latestJob = undefined;
      this.contextExpires = message.payload.expires_at_ms;
      if (this.contextTimer) clearTimeout(this.contextTimer);
      this.contextTimer = setTimeout(
        () => {
          void this.revoke().catch(() => {});
        },
        Math.max(0, this.contextExpires - this.now()),
      );
    }
    if (
      message.kind === "context.offer" ||
      (message.kind === "result.dismissed" &&
        this.activeBinding &&
        sameBinding(this.activeBinding, message.binding))
    )
      this.stopPoll();
    const owner = this.pollOwner;
    const changesOwner =
      message.kind === "context.offer" || message.kind === "result.dismissed";
    let input: CodingControlInput;
    switch (message.kind) {
      case "context.offer":
        input = { operation: "context", params: message.payload };
        break;
      case "test.preview":
        input = { operation: "test_prepare", params: message.payload };
        break;
      case "review.decision":
        input = { operation: "review", params: message.payload };
        break;
      case "journal.intent":
        input = { operation: "intent", params: message.payload };
        break;
      case "journal.observed":
        input = { operation: "observation", params: message.payload };
        break;
      case "result.dismissed":
        input = {
          operation: "finish",
          params: { job_id: message.binding.job_id },
        };
        break;
      case "revoke":
        await this.revoke();
        return;
      default:
        invalid();
    }
    const reply = await control(input);
    if (reply.operation !== input.operation) invalid();
    if (
      !this.current(session, view, epoch) ||
      (changesOwner && owner !== this.pollOwner)
    )
      return;
    switch (reply.operation) {
      case "context":
      case "test_prepare":
      case "finish": {
        const job = parseCodeJobView(reply.result);
        if (!sameBinding(job.binding, message.binding)) invalid();
        await session.send({
          kind: "job.status",
          binding: message.binding,
          payload: job,
        });
        if (
          !this.current(session, view, epoch) ||
          (changesOwner && owner !== this.pollOwner)
        )
          return;
        if (reply.operation === "context") {
          this.activeBinding = job.binding;
          this.offeredRevision = 0;
          this.cache(job);
          this.poll(session, view, epoch);
        } else if (
          this.latestJob &&
          sameBinding(this.latestJob.binding, job.binding)
        ) {
          this.cache(job);
          if (reply.operation === "finish") this.stopPoll();
        }

        break;
      }
      case "review":
        await session.send({
          kind: "grant.reply",
          binding: message.binding,
          payload: reply.result,
        });
        break;
      case "intent":
      case "observation":
        if (!(
          (message.kind === "journal.intent" ||
            message.kind === "journal.observed") &&
          reply.result.operation_id === message.payload.operation_id &&
          reply.result.effect_id === message.payload.effect_id
        ))
          invalid();
        await session.send({
          kind: "journal.ack",
          binding: message.binding,
          payload: reply.result,
        });
        break;
      default:
        invalid();
    }
  }
  pairingAvailable(): boolean {
    try {
      this.checkClock();
      return !!this.server && !this.closed && !this.revoking;
    } catch {
      return false;
    }
  }
  pairView(): PairView | null {
    if (!this.view || this.closed || this.revoking) return null;
    if (!this.session?.paired) {
      try {
        this.checkClock();
      } catch {
        void this.revoke().catch(() => {});
        return null;
      }
    }
    return structuredClone({
      ...this.view,
      status: this.session?.paired ? "paired" : "awaiting_confirmation",
    });
  }
  currentCodingJob(): CodeJobView | undefined {
    const pair = this.pairView(),
      job = this.latestJob,
      now = this.now();
    if (!pair || pair.status !== "paired" || !job) return undefined;
    if (
      !Number.isFinite(now) ||
      now < this.last ||
      now >= this.contextExpires ||
      now >= Date.parse(job.expires_at)
    ) {
      void this.revoke().catch(() => {});
      return undefined;
    }
    this.last = now;
    if (
      job.binding.pair_id !== pair.pair_id ||
      job.binding.window_id !== pair.window_id ||
      job.binding.root_id !== pair.root_id
    )
      return undefined;
    return structuredClone(job);
  }
  codingJobStatus(jobId: string): CodeJobView | undefined {
    const job = this.currentCodingJob();
    return job?.binding.job_id === jobId ? job : undefined;
  }
  private cache(value: CodeJobView): void {
    this.latestJob = parseCodeJobView(value);
    const job = this.currentCodingJob();
    if (job) {
      try {
        this.options.onJobStatus?.(job);
      } catch {
        /* UI does not own transport. */
      }
    }
  }
  private stopPoll(): void {
    this.pollOwner++;
    if (this.polling) clearTimeout(this.polling);
    this.polling = undefined;
    this.activeBinding = undefined;
  }
  private ownsPoll(
    session: BridgeSession,
    view: PairView,
    epoch: number,
    owner: number,
    binding: CodeBinding,
  ): boolean {
    return (
      this.current(session, view, epoch) &&
      this.pollOwner === owner &&
      this.activeBinding !== undefined &&
      sameBinding(this.activeBinding, binding)
    );
  }
  private poll(session: BridgeSession, view: PairView, epoch: number): void {
    if (
      !this.options.codingStatus ||
      !this.options.codingControl ||
      !this.activeBinding ||
      this.polling ||
      this.pollInFlight
    )
      return;
    const binding = this.activeBinding,
      owner = this.pollOwner;
    this.polling = setTimeout(() => {
      if (!this.ownsPoll(session, view, epoch, owner, binding)) return;
      this.polling = undefined;
      this.pollInFlight = true;
      void (async () => {
        try {
          const value = await this.options.codingStatus!(binding.job_id);
          if (!this.ownsPoll(session, view, epoch, owner, binding)) return;
          const job = parseCodeJobView(value);
          if (!sameBinding(job.binding, binding)) invalid();
          this.cache(job);
          if (!this.ownsPoll(session, view, epoch, owner, binding)) return;
          await session.send({ kind: "job.status", binding, payload: job });
          if (!this.ownsPoll(session, view, epoch, owner, binding)) return;
          if (
            job.state === "review_required" &&
            this.offeredRevision !== binding.revision
          ) {
            const reply = await this.options.codingControl!({
              operation: "proposal_get",
              params: { job_id: binding.job_id },
            });
            if (!this.ownsPoll(session, view, epoch, owner, binding)) return;
            if (reply.operation !== "proposal_get") invalid();
            await session.send({
              kind: "proposal.offer",
              binding,
              payload: reply.result,
            });
            if (!this.ownsPoll(session, view, epoch, owner, binding)) return;
            this.offeredRevision = binding.revision;
          }
          if (
            ![
              "context_ready",
              "proposing",
              "review_required",
              "applying",
              "applied_saved",
              "test_review",
              "testing",
            ].includes(job.state)
          )
            this.stopPoll();
        } catch {
          if (this.ownsPoll(session, view, epoch, owner, binding))
            await this.revoke();
        } finally {
          this.pollInFlight = false;
          // A replaced owner waits for the old request to settle; it never overlaps it.
          if (this.session && this.view)
            this.poll(this.session, this.view, this.epoch);
        }
      })();
    }, 1000);
  }
  async revoke(): Promise<void> {
    if (this.revoking) return this.closingPair;
    if (!this.server && !this.session && !this.secret && !this.peers.size)
      return;
    this.revoking = true;
    const view = this.view;
    const session = this.session;
    this.epoch++;
    this.stopPoll();
    this.latestJob = undefined;
    this.contextExpires = 0;
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = undefined;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.secret?.fill(0);
    this.secret = undefined;
    this.session = undefined;
    this.view = undefined;
    const server = this.server;
    this.server = undefined;
    session?.close();
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    let notificationError: unknown;
    let notified: Promise<void> | undefined;
    try {
      notified = Promise.resolve(this.options.onClose?.(view)).catch(
        (error) => {
          notificationError = error;
        },
      );
    } catch (error) {
      notificationError = error;
    }
    this.closingPair = (async () => {
      try {
        if (view && this.options.codingControl)
          await this.options.codingControl({
            operation: "revoke_pair",
            params: { pair_id: view.pair_id },
          });
      } finally {
        try {
          await notified;
          if (notificationError) throw notificationError;
        } finally {
          if (server)
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    })();
    try {
      await this.closingPair;
    } finally {
      this.closingPair = undefined;
      this.revoking = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.revoke();
  }
}
function sameBinding(left: CodeBinding, right: CodeBinding): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof CodeBinding] === right[key as keyof CodeBinding],
  );
}
