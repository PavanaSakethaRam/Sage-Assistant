/** Durable metadata only. A local receipt never authorizes an effect by itself. */
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  rmdir,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOCUS_NAMES,
  parseCodeAck,
  type CodeBinding,
  parseCodeIntent,
  parseCodeReceipt,
  type CodeAck,
  type CodeIntent,
  type CodeReceipt,
  type TestRecipe,
  type FocusName,
} from "../../desktop/shared/coding-contracts";

type PrivateRecipe = Pick<
  TestRecipe,
  | "recipe_hash"
  | "executable_hash"
  | "executable_identity"
  | "executable_version"
  | "argv"
  | "deadline"
  | "output_cap"
  | "timeout_seconds"
> & { environment_hash: string };
export type JournalIntent = Omit<CodeIntent, "recipe" | "target"> &
  ({ target: FocusName } | { recipe: PrivateRecipe });
export type JournalOperation = {
  version: 1;
  operation_id: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  intents: JournalIntent[];
  observations: CodeReceipt[];
  ack_ids: CodeAck[];
};
export class PendingJournalError extends Error {
  constructor() {
    super(
      "Sage found an interrupted private journal write; use Sage: Inspect interrupted Sage journal before pairing.",
    );
  }
}
export type PendingEvidence = Readonly<{
  name: string;
  classification:
    | "supported_v1"
    | "malformed_v1"
    | "future_version"
    | "unrecognized"
    | "unsafe";
  digest: string | null;
  mtime: number | null;
  identity: string | null;
  operation?: JournalOperation;
}>;
export type JobEvidence = Readonly<{
  complete: boolean;
  operations: readonly JournalOperation[];
}>;
const RETENTION = 30 * 86400000,
  CAP = 1048576,
  MAX_OPERATIONS = 1024;
function invalid(): never {
  throw Error("Journal reconciliation required");
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return invalid();
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export function journalHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function owned<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export function intentProjection(value: CodeIntent): JournalIntent {
  const valid = owned(parseCodeIntent(value));
  if (valid.scope !== "code.test") return valid;
  const { recipe, ...common } = valid;
  return {
    ...common,
    recipe: {
      recipe_hash: recipe.recipe_hash,
      environment_hash: journalHash(recipe.environment),
      executable_hash: recipe.executable_hash,
      executable_identity: recipe.executable_identity,
      executable_version: recipe.executable_version,
      argv: [...recipe.argv],
      deadline: recipe.deadline,
      output_cap: recipe.output_cap,
      timeout_seconds: recipe.timeout_seconds,
    },
  };
}
export function receiptProjection(value: CodeReceipt): CodeReceipt {
  const valid = owned(parseCodeReceipt(value));
  return valid.scope === "code.test"
    ? {
        ...valid,
        exit_code: valid.exit_code ?? null,
        signal: valid.signal ?? null,
        output_digest: valid.output_digest ?? null,
      }
    : {
        ...valid,
        observed_hash: valid.observed_hash ?? null,
        observed_length: valid.observed_length ?? null,
      };
}
export function requireFreshAcks(
  local: CodeAck,
  core: CodeAck | undefined,
): void {
  parseCodeAck(local);
  if (!core) invalid();
  parseCodeAck(core);
  if (
    local.status !== "recorded" ||
    core.status !== "recorded" ||
    local.operation_id !== core.operation_id ||
    local.effect_id !== core.effect_id ||
    local.recorded_hash !== core.recorded_hash
  )
    invalid();
}
function parseProjection(value: JournalIntent): JournalIntent {
  if (value.scope !== "code.test") return intentProjection(value as CodeIntent);
  if (
    !("recipe" in value) ||
    !/^[a-f0-9]{64}$/.test(value.recipe.environment_hash)
  )
    invalid();
  const { environment_hash, ...recipe } = value.recipe;
  const full = {
    ...value,
    recipe: {
      ...recipe,
      platform: "darwin",
      executable: "/owned/node",
      cwd: "/owned/workspace",
      root_id: "root",
      environment: {
        PATH: "",
        TEMP: "/owned/temp",
        TMP: "/owned/temp",
        TMPDIR: "/owned/temp",
      },
      file_hashes: FOCUS_NAMES.map((name) => ({ name, hash: "a".repeat(64) })),
    },
  };
  const checked = intentProjection(full as CodeIntent);
  if (!("recipe" in checked)) invalid();
  checked.recipe.environment_hash = environment_hash;
  if (canonical(checked) !== canonical(value)) invalid();
  return checked;
}
function ack(
  value: JournalIntent | CodeReceipt,
  status: CodeAck["status"],
  hash?: string,
): CodeAck {
  return {
    operation_id: value.operation_id,
    effect_id: value.effect_id,
    status,
    recorded_hash: hash ?? null,
  };
}
function parseOperation(value: JournalOperation, id: string): JournalOperation {
  if (
    !value ||
    Object.keys(value).sort().join() !==
      "ack_ids,created_at,expires_at,intents,observations,operation_id,updated_at,version" ||
    value.version !== 1 ||
    value.operation_id !== id ||
    !Array.isArray(value.intents) ||
    !Array.isArray(value.observations) ||
    !Array.isArray(value.ack_ids) ||
    value.intents.length < 1 ||
    value.intents.length > 4 ||
    value.observations.length > 4 ||
    value.ack_ids.length !== value.intents.length + value.observations.length
  )
    invalid();
  const created = Date.parse(value.created_at),
    updated = Date.parse(value.updated_at),
    expires = Date.parse(value.expires_at);
  if (
    !Number.isFinite(created) ||
    new Date(created).toISOString() !== value.created_at ||
    !Number.isFinite(updated) ||
    new Date(updated).toISOString() !== value.updated_at ||
    updated < created ||
    expires - updated !== RETENTION ||
    new Date(expires).toISOString() !== value.expires_at
  )
    invalid();
  const first = value.intents[0];
  const records = [...value.intents, ...value.observations];
  for (const [i, record] of value.intents.entries()) {
    const checked = parseProjection(record);
    if (
      canonical(checked) !== canonical(record) ||
      record.operation_id !== id ||
      record.ordinal !== i ||
      canonical(record.binding) !== canonical(first.binding) ||
      record.scope !== first.scope ||
      new Set(value.intents.map((x) => x.effect_id)).size !==
        value.intents.length ||
      (record.scope !== "code.create" && value.intents.length !== 1)
    )
      invalid();
  }
  for (const [ordinal, record] of value.observations.entries()) {
    if (
      record.ordinal !== ordinal ||
      canonical(receiptProjection(record)) !== canonical(record) ||
      !value.intents.some((x) => matches(x, record))
    )
      invalid();
  }
  if (
    new Set(value.observations.map((x) => x.effect_id)).size !==
    value.observations.length
  )
    invalid();
  for (const a of value.ack_ids) {
    parseCodeAck(a);
    const index = records.findIndex(
      (record) =>
        a.effect_id === record.effect_id &&
        a.recorded_hash === journalHash(record),
    );
    if (a.status !== "recorded" || a.operation_id !== id || index < 0)
      invalid();
    records.splice(index, 1);
  }
  return value;
}
function matches(intent: JournalIntent, receipt: CodeReceipt): boolean {
  return (
    intent.operation_id === receipt.operation_id &&
    intent.effect_id === receipt.effect_id &&
    intent.ordinal === receipt.ordinal &&
    intent.scope === receipt.scope &&
    intent.expected_hash === receipt.expected_hash &&
    canonical(intent.binding) === canonical(receipt.binding) &&
    ("target" in intent && "target" in receipt
      ? intent.target === receipt.target
      : intent.scope === "code.test" &&
        receipt.scope === "code.test" &&
        "recipe" in intent &&
        intent.recipe.environment_hash === receipt.environment_hash &&
        intent.recipe.executable_hash === receipt.executable_hash &&
        intent.recipe.executable_version === receipt.executable_version)
  );
}
/** One bounded journal per operation; serialized flush/replace and absolute retention. */
export class EffectJournal {
  private readonly root: string;
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  private pendingChoices = new WeakSet<PendingEvidence>();
  constructor(storageUri: { toString(): string }) {
    const uri = new URL(storageUri.toString());
    if (uri.protocol !== "file:" || uri.host || uri.search || uri.hash)
      invalid();
    this.root = fileURLToPath(uri);
  }
  private clock(now = Date.now()): number {
    if (!Number.isFinite(now) || now < this.last) invalid();
    this.last = now;
    return now;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) invalid();
    return join(this.root, `operation-${id}.json`);
  }
  private async directory(allowPending = false): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    if (
      !allowPending &&
      (await readdir(this.root)).some((name) =>
        /^pending-[0-9a-f]{32}$/.test(name),
      )
    )
      throw new PendingJournalError();
  }
  private async readText(path: string): Promise<{ text: string; info: Stats }> {
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > CAP
    )
      invalid();
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!this.sameFile(before, info)) invalid();
      const bytes = Buffer.alloc(CAP + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        length += result.bytesRead;
        if (!result.bytesRead) break;
      }
      const after = await handle.stat();
      if (length > CAP || length !== info.size || !this.sameFile(info, after))
        invalid();
      return {
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, length),
        ),
        info,
      };
    } finally {
      await handle.close();
    }
  }
  private sameFile(a: Stats, b: Stats): boolean {
    return (
      a.isFile() &&
      b.isFile() &&
      !a.isSymbolicLink() &&
      !b.isSymbolicLink() &&
      a.nlink === 1 &&
      b.nlink === 1 &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeMs === b.mtimeMs &&
      a.ctimeMs === b.ctimeMs
    );
  }
  private async read(id: string): Promise<JournalOperation> {
    const { text } = await this.readText(this.path(id));
    const value = JSON.parse(text);
    if (canonical(value) !== text) invalid();
    return parseOperation(value, id);
  }
  private async expirePending(name: string, time: number): Promise<void> {
    const path = join(this.root, name),
      { text, info } = await this.readText(path);
    if (
      !Number.isFinite(info.mtimeMs) ||
      info.mtimeMs < 0 ||
      info.mtimeMs > time ||
      time - info.mtimeMs <= RETENTION
    )
      invalid();
    const versions = [...text.matchAll(/"version"\s*:\s*([0-9]+)/g)].map(
      (match) => match[1],
    );
    if (versions.some((version) => version !== "1")) invalid();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // Partial version1 writes can age out; unknown or future versions require inspection.
      if (!versions.length) invalid();
    }
    if (value !== undefined) {
      if (
        !value ||
        typeof value !== "object" ||
        !("version" in value) ||
        value.version !== 1
      )
        invalid();
      let supported: JournalOperation | undefined;
      try {
        supported = parseOperation(
          value as JournalOperation,
          (value as JournalOperation).operation_id,
        );
      } catch {
        /* Malformed version1 metadata remains uncertain; never replay it. */
      }
      if (supported && time < Date.parse(supported.expires_at)) invalid();
    }
    const current = await lstat(path);
    if (!this.sameFile(info, current)) invalid();
    await unlink(path);
  }
  private async existing(id: string): Promise<JournalOperation | undefined> {
    try {
      return await this.read(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async write(value: JournalOperation): Promise<void> {
    parseOperation(value, value.operation_id);
    const bytes = Buffer.from(canonical(value));
    if (bytes.length > CAP) invalid();
    const temp = join(this.root, `pending-${randomBytes(16).toString("hex")}`);
    let handle;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, this.path(value.operation_id));
      // Windows does not offer portable directory fsync; file flush/rename is still required.
      if (process.platform !== "win32") {
        const directory = await open(this.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await handle?.close();
      await unlink(temp).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
  intent(value: CodeIntent): Promise<CodeAck> {
    const projection = intentProjection(value);
    return this.serial(async () => {
      const now = this.clock();
      await this.directory();
      let operation = await this.existing(projection.operation_id);
      if (operation) {
        if (
          now < Date.parse(operation.updated_at) ||
          now >= Date.parse(operation.expires_at)
        )
          invalid();
        const prior = operation.intents.find(
          (x) => x.effect_id === projection.effect_id,
        );
        if (prior)
          return ack(
            projection,
            journalHash(prior) === journalHash(projection)
              ? "duplicate"
              : "conflict",
            journalHash(prior) === journalHash(projection)
              ? journalHash(prior)
              : undefined,
          );
        if (
          projection.ordinal !== operation.intents.length ||
          operation.intents.length >= 4 ||
          projection.scope !== "code.create" ||
          operation.intents[0].scope !== projection.scope ||
          canonical(operation.intents[0].binding) !==
            canonical(projection.binding) ||
          operation.intents.some(
            (x) =>
              "target" in x &&
              "target" in projection &&
              x.target === projection.target,
          )
        )
          invalid();
      } else {
        if (
          projection.ordinal !== 0 ||
          (await readdir(this.root)).filter((n) =>
            /^operation-[A-Za-z0-9_-]+\.json$/.test(n),
          ).length >= MAX_OPERATIONS
        )
          invalid();
        operation = {
          version: 1,
          operation_id: projection.operation_id,
          created_at: new Date(now).toISOString(),
          updated_at: new Date(now).toISOString(),
          expires_at: new Date(now + RETENTION).toISOString(),
          intents: [],
          observations: [],
          ack_ids: [],
        };
      }
      const result = ack(projection, "recorded", journalHash(projection));
      operation.intents.push(projection);
      operation.ack_ids.push(result);
      operation.updated_at = new Date(now).toISOString();
      operation.expires_at = new Date(now + RETENTION).toISOString();
      await this.write(operation);
      return result;
    });
  }
  observed(value: CodeReceipt): Promise<CodeAck> {
    const projection = receiptProjection(value);
    return this.serial(async () => {
      const now = this.clock();
      await this.directory();
      const operation = await this.read(projection.operation_id);
      if (
        now < Date.parse(operation.updated_at) ||
        now >= Date.parse(operation.expires_at)
      )
        invalid();
      const prior = operation.observations.find(
        (x) => x.effect_id === projection.effect_id,
      );
      if (prior)
        return ack(
          projection,
          journalHash(prior) === journalHash(projection)
            ? "duplicate"
            : "conflict",
          journalHash(prior) === journalHash(projection)
            ? journalHash(prior)
            : undefined,
        );
      if (
        !operation.intents.some((x) => matches(x, projection)) ||
        operation.observations.length >= 4 ||
        projection.ordinal !== operation.observations.length
      )
        invalid();
      const result = ack(projection, "recorded", journalHash(projection));
      operation.observations.push(projection);
      operation.ack_ids.push(result);
      operation.updated_at = new Date(now).toISOString();
      operation.expires_at = new Date(now + RETENTION).toISOString();
      await this.write(operation);
      return result;
    });
  }
  get(id: string): Promise<JournalOperation> {
    this.path(id);
    return this.serial(async () => {
      const now = this.clock();
      await this.directory();
      const value = await this.read(id);
      if (
        now < Date.parse(value.updated_at) ||
        now >= Date.parse(value.expires_at)
      )
        invalid();
      return value;
    });
  }
  private identity(info: Stats): string {
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(
      ":",
    );
  }
  private async pending(name: string): Promise<PendingEvidence> {
    if (!/^pending-[0-9a-f]{32}$/.test(name)) invalid();
    try {
      const path = join(this.root, name);
      const { text, info } = await this.readText(path);
      if (
        !this.sameFile(info, await lstat(path)) ||
        !Number.isFinite(info.mtimeMs) ||
        info.mtimeMs < 0 ||
        Math.floor(info.mtimeMs) > this.clock()
      )
        invalid();
      const base = {
        name,
        digest: createHash("sha256").update(text, "utf8").digest("hex"),
        mtime: info.mtimeMs,
        identity: this.identity(info),
      };
      const versions = [...text.matchAll(/"version"\s*:\s*([^,}\]\s]+)/g)].map(
        (match) => match[1],
      );
      let classification: PendingEvidence["classification"] = "unrecognized";
      let operation: JournalOperation | undefined;
      if (
        versions.length &&
        versions.some((version) => /^[0-9]+$/.test(version) && version !== "1")
      )
        classification = "future_version";
      else if (
        versions.length &&
        versions.every((version) => version === "1")
      ) {
        classification = "malformed_v1";
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* Recognizable partial version1 evidence. */
        }
        if (parsed !== undefined) {
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("version" in parsed) ||
            parsed.version !== 1
          )
            classification = "unrecognized";
          else {
            try {
              const candidate = parsed as JournalOperation;
              if (canonical(candidate) !== text) invalid();
              this.path(candidate.operation_id);
              operation = parseOperation(candidate, candidate.operation_id);
              classification = "supported_v1";
            } catch {
              operation = undefined;
            }
          }
        }
      }
      if (operation && this.clock() < Date.parse(operation.updated_at))
        invalid();
      const result: PendingEvidence = Object.freeze({
        ...base,
        classification,
        ...(operation ? { operation } : {}),
      });
      if (
        classification === "supported_v1" ||
        classification === "malformed_v1"
      )
        this.pendingChoices.add(result);
      return result;
    } catch {
      return {
        name,
        classification: "unsafe",
        digest: null,
        mtime: null,
        identity: null,
      };
    }
  }
  inspectPending(): Promise<{
    complete: boolean;
    entries: readonly PendingEvidence[];
  }> {
    return this.serial(async () => {
      const started = this.clock();
      await this.directory(true);
      const names = (await readdir(this.root)).filter((name) =>
        /^pending-[0-9a-f]{32}$/.test(name),
      );
      if (names.length > MAX_OPERATIONS)
        return { complete: false, entries: [] };
      const entries: PendingEvidence[] = [];
      let size = 0;
      for (const name of names) {
        const now = this.clock();
        if (now - started >= 30000 || size >= 8 * CAP)
          return { complete: false, entries };
        const entry = await this.pending(name);
        this.clock();
        size += entry.identity ? Number(entry.identity.split(":")[2]) : CAP;
        entries.push(entry);
      }
      return {
        complete: this.clock() - started < 30000 && size <= 8 * CAP,
        entries,
      };
    });
  }
  acknowledgePending(choice: PendingEvidence): Promise<void> {
    return this.serial(async () => {
      this.clock();
      if (!this.pendingChoices.has(choice)) invalid();
      this.pendingChoices.delete(choice);
      await this.directory(true);
      const checked = await this.pending(choice.name);
      if (
        !this.pendingChoices.has(checked) ||
        checked.classification !== choice.classification ||
        checked.digest !== choice.digest ||
        checked.identity !== choice.identity
      )
        invalid();
      const destination = join(
        this.root,
        `acknowledged-${randomBytes(16).toString("hex")}`,
      );
      await mkdir(destination, { mode: 0o700 });
      const dir = await lstat(destination);
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        (await readdir(destination)).length
      )
        invalid();
      this.clock();
      // Re-read immediately before rename; the new exclusive directory has an empty destination.
      const final = await this.pending(choice.name);
      if (
        final.identity !== choice.identity ||
        final.digest !== choice.digest ||
        final.classification !== choice.classification
      )
        invalid();
      const source = join(this.root, choice.name),
        target = join(destination, choice.name);
      const before = await lstat(source);
      if (this.identity(before) !== choice.identity) invalid();
      await rename(source, target);
      const moved = await this.readText(target);
      const current = await lstat(target);
      if (
        moved.info.dev !== before.dev ||
        moved.info.ino !== before.ino ||
        moved.info.size !== before.size ||
        moved.info.mtimeMs !== before.mtimeMs ||
        !this.sameFile(moved.info, current) ||
        createHash("sha256").update(moved.text, "utf8").digest("hex") !==
          choice.digest
      )
        invalid();
      this.clock();
    });
  }
  inspectJob(binding: CodeBinding): Promise<JobEvidence> {
    if (
      Object.keys(binding).sort().join() !==
        "boot_id,job_id,pair_id,policy_version,revision,root_id,window_id" ||
      [
        binding.job_id,
        binding.boot_id,
        binding.pair_id,
        binding.window_id,
        binding.root_id,
      ].some(
        (value) =>
          typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value),
      ) ||
      !Number.isSafeInteger(binding.revision) ||
      binding.revision < 1 ||
      binding.policy_version !== "code-v1"
    )
      invalid();
    const expected = canonical(binding);
    return this.serial(async () => {
      const operations: JournalOperation[] = [];
      const started = this.clock();
      let total = 0;
      try {
        await this.directory();
        const names = (await readdir(this.root)).filter((name) =>
          /^operation-[A-Za-z0-9_-]{1,64}\.json$/.test(name),
        );
        if (names.length > MAX_OPERATIONS)
          return { complete: false, operations: [] };
        for (const name of names) {
          const now = this.clock();
          if (now - started >= 30000) return { complete: false, operations };
          const path = join(this.root, name),
            info = await lstat(path);
          total += info.size;
          if (total > 8 * CAP) return { complete: false, operations };
          const { text, info: opened } = await this.readText(path);
          if (
            !this.sameFile(info, opened) ||
            !this.sameFile(opened, await lstat(path))
          )
            invalid();
          const value = JSON.parse(text) as JournalOperation;
          if (canonical(value) !== text) invalid();
          const record = parseOperation(value, name.slice(10, -5));
          const time = this.clock();
          if (time - started >= 30000 || time < Date.parse(record.updated_at))
            invalid();
          if (time >= Date.parse(record.expires_at)) continue;
          if (canonical(record.intents[0].binding) === expected)
            operations.push(record);
        }
        return { complete: true, operations };
      } catch {
        return { complete: false, operations };
      }
    });
  }
  expire(now: Date): Promise<void> {
    const time = now.getTime();
    return this.serial(async () => {
      this.clock(time);
      await this.directory(true);
      for (const name of await readdir(this.root)) {
        if (/^pending-[0-9a-f]{32}$/.test(name)) {
          try {
            await this.expirePending(name, time);
          } catch {
            throw new PendingJournalError();
          }
          continue;
        }
        if (/^acknowledged-[0-9a-f]{32}$/.test(name)) {
          const path = join(this.root, name),
            info = await lstat(path);
          if (!info.isDirectory() || info.isSymbolicLink()) invalid();
          const retained = await readdir(path);
          if (
            retained.length > 1 ||
            retained.some((entry) => !/^pending-[0-9a-f]{32}$/.test(entry))
          )
            invalid();
          if (retained.length) {
            const pendingPath = join(name, retained[0]);
            const stat = await lstat(join(this.root, pendingPath));
            if (time <= stat.mtimeMs || time - stat.mtimeMs <= RETENTION)
              continue;
            await this.expirePending(pendingPath, time);
          }
          await rmdir(path);
          continue;
        }
        const match = /^operation-([A-Za-z0-9_-]{1,64})\.json$/.exec(name);
        if (!match) continue;
        const value = await this.read(match[1]);
        if (time < Date.parse(value.updated_at)) invalid();
        if (time >= Date.parse(value.expires_at))
          await unlink(this.path(match[1]));
      }
    });
  }
}
