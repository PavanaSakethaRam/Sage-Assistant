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
  transcript,
  verifyProof,
  type BridgeData,
  type PairTicket,
  type PairView,
} from "../shared/editor-bridge";
type HostOptions = {
  onData: (message: BridgeData) => void | Promise<void>;
  onPair: (view: PairView) => void;
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
        if (this.session?.peer === peer) void this.revoke();
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
          const session = new BridgeSession(
            peer,
            key,
            "host",
            view,
            this.options.onData,
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
        void this.revoke();
      });
      const address = server.address();
      if (!address || typeof address === "string") invalid();
      this.expiry = setTimeout(() => {
        if (!this.session?.paired) void this.revoke();
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
    return this.session.confirm();
  }
  async send(message: BridgeData): Promise<void> {
    if (!this.session) invalid();
    await this.session.send(message);
  }
  async revoke(): Promise<void> {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.secret?.fill(0);
    this.secret = undefined;
    this.session = undefined;
    this.view = undefined;
    const server = this.server;
    this.server = undefined;
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.revoke();
  }
}
