/** One private local gesture, four independently durable exclusive creates. */
import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  FOCUS_NAMES,
  type CodeContext,
  type CodeProposal,
  type CodeReceipt,
  type CodeIntent,
} from "../../desktop/shared/coding-contracts";
import { validateCreateProgress, type CreatedPrefix } from "./context";
import { consumeLocalReview, type LocalReview } from "./review";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export async function createFocusProject(
  context: CodeContext,
  proposal: CodeProposal,
  approval: LocalReview,
): Promise<readonly CodeReceipt[]> {
  const owner = consumeLocalReview(approval, context, proposal),
    prefix: CreatedPrefix[] = [],
    receipts: CodeReceipt[] = [];
  for (const [ordinal, name] of FOCUS_NAMES.entries()) {
    owner.check();
    let root = await validateCreateProgress(context, proposal, prefix);
    owner.check();
    const bytes = Buffer.from(
      proposal.files.find((f) => f.name === name)!.text,
      "utf8",
    );
    const intent: CodeIntent = {
      binding: context.binding,
      scope: "code.create",
      operation_id: owner.grant.operation_id,
      effect_id: randomBytes(16).toString("hex"),
      ordinal,
      target: name,
      expected_hash: hash(bytes),
    };
    await owner.bridge.recordIntent(owner.journal, intent);
    // No effect has happened: a failed guard here needs no fabricated file receipt.
    owner.check();
    root = await validateCreateProgress(context, proposal, prefix);
    owner.check();
    let status: "created" | "partial" | "needs_reconciliation" = "partial";
    let observedHash: string | null = null,
      observedLength: number | null = null;
    let failure: unknown;
    try {
      const path = join(root, name),
        handle = await open(path, "wx", 0o600);
      status = "needs_reconciliation";
      let written = false;
      let identity: BigIntStats | undefined;
      try {
        owner.check();
        const initial = await handle.stat({ bigint: true });
        owner.check();
        if (!initial.isFile() || initial.nlink !== 1n)
          throw Error("Created identity uncertain");
        try {
          const result = await handle.write(bytes, 0, bytes.length, 0);
          written = result.bytesWritten === bytes.length;
          if (!written) throw Error("Incomplete create write");
        } catch (error) {
          status = "partial";
          throw error;
        }
        owner.check();
        identity = await handle.stat({ bigint: true });
        owner.check();
        if (
          identity.dev.toString() !== initial.dev.toString() ||
          identity.ino.toString() !== initial.ino.toString()
        )
          throw Error("Created identity changed");
      } finally {
        // A close failure makes even a known incomplete write uncertain.
        try {
          await handle.close();
        } catch (error) {
          status = "needs_reconciliation";
          throw error;
        }
      }
      owner.check();
      const reader = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        owner.check();
        const before = await reader.stat({ bigint: true });
        owner.check();
        if (
          !before.isFile() ||
          before.nlink !== 1n ||
          before.dev.toString() !== identity!.dev.toString() ||
          before.ino.toString() !== identity!.ino.toString() ||
          before.size !== BigInt(bytes.length)
        )
          throw Error("Created identity changed");
        const buffer = Buffer.alloc(bytes.length + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await reader.read(
            buffer,
            offset,
            buffer.length - offset,
            offset,
          );
          owner.check();
          offset += read.bytesRead;
          if (!read.bytesRead) break;
        }
        const actual = buffer.subarray(0, offset);
        owner.check();
        const after = await reader.stat({ bigint: true });
        owner.check();
        const disk = await lstat(path, { bigint: true });
        owner.check();
        if (
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs ||
          disk.dev !== before.dev ||
          disk.ino !== before.ino ||
          disk.nlink !== 1n ||
          !actual.equals(bytes)
        )
          throw Error("Created bytes changed");
        prefix.push({ name, stat: after });
      } finally {
        await reader.close();
      }
      owner.check();
      await validateCreateProgress(context, proposal, prefix);
      owner.check();
      observedHash = intent.expected_hash;
      observedLength = bytes.length;
      status = "created";
    } catch (error) {
      failure = error;
    }
    const receipt: CodeReceipt = {
      ...intent,
      scope: "code.create",
      status,
      observed_hash: observedHash,
      observed_length: observedLength,
    };
    receipts.push(receipt);
    // Persist the honest observation even if the owner cancelled after opening.
    // Lost Core ACK leaves this same local receipt; never retry or contradict it.
    await owner.bridge.recordObserved(owner.journal, receipt);
    owner.check();
    if (failure) throw failure;
  }
  await validateCreateProgress(context, proposal, prefix);
  owner.check();
  return Object.freeze(receipts);
}
