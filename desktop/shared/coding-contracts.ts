/** Closed coding values shared by renderer and trusted host; no Node APIs. */
export const FOCUS_NAMES = [
  "index.html",
  "focus.js",
  "focus.test.mjs",
  "README.md",
] as const;
export type FocusName = (typeof FOCUS_NAMES)[number];
export type CodeMode = "create_focus_project" | "replace_focus_file";
export type CodeScope = "code.create" | "code.replace" | "code.test";
export type CodeState =
  | "context_ready"
  | "proposing"
  | "review_required"
  | "applying"
  | "applied_saved"
  | "applied_unsaved"
  | "needs_review"
  | "test_review"
  | "testing"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed"
  | "partial"
  | "interrupted"
  | "needs_reconciliation";
export type CodeBinding = Readonly<{
  job_id: string;
  boot_id: string;
  pair_id: string;
  window_id: string;
  root_id: string;
  revision: number;
  policy_version: "code-v1";
}>;
export type CodeSource = Readonly<{ name: FocusName; text: string }>;
export type CodeFile = Readonly<
  CodeSource & {
    text_hash: string;
    disk_hash: string;
    document_version: number;
    file_id: string;
  }
>;
export type CodeContext = Readonly<{
  binding: CodeBinding;
  mode: CodeMode;
  root_uri: string;
  root_file_id: string;
  files: readonly CodeFile[];
  diagnostics?: readonly string[];
  context_hash: string;
  target?: FocusName | null;
}>;
export type CodeDraft = Readonly<{
  job_id: string;
  revision: number;
  account_generation: number;
  user_text: string;
  backend: "copilot";
  model?: string | null;
}>;
export type CodeStart = Readonly<CodeDraft & { disclosure_hash: string }>;
export type CodeModelRequest = Readonly<
  CodeStart & {
    request_id: string;
    deadline: string;
    mode: CodeMode;
    files: readonly CodeSource[];
    diagnostics?: readonly string[];
    target?: FocusName;
  }
>;
export type CodeProposal = Readonly<{
  job_id: string;
  revision: number;
  explanation: string;
  files: readonly CodeSource[];
}>;
export type CodeHashRecord = Readonly<{
  name: FocusName;
  source_hash: string | null;
  proposed_hash: string | null;
  observed_hash: string | null;
}>;
export type CodeFileReceipt = Readonly<
  {
    binding: CodeBinding;
    operation_id: string;
    effect_id: string;
    target: FocusName;
    ordinal: number;
    expected_hash: string;
    observed_hash?: string | null;
    observed_length?: number | null;
  } & (
    | {
        scope: "code.create";
        status: "created" | "partial" | "needs_reconciliation";
      }
    | {
        scope: "code.replace";
        status:
          | "applied_saved"
          | "applied_unsaved"
          | "needs_review"
          | "needs_reconciliation";
      }
  )
>;
export type CodeTestReceipt = Readonly<{
  binding: CodeBinding;
  operation_id: string;
  effect_id: string;
  scope: "code.test";
  ordinal: number;
  expected_hash: string;
  status:
    | "passed"
    | "failed"
    | "cancelled"
    | "changed_during_test"
    | "unknown"
    | "termination_unconfirmed";
  environment_hash: string;
  executable_hash: string;
  executable_version: string;
  exit_code?: number | null;
  signal?: string | null;
  cancel_requested: boolean;
  timeout: boolean;
  overflow: boolean;
  output_digest?: string | null;
}>;
export type CodeReceipt = CodeFileReceipt | CodeTestReceipt;
export type CodeJobView = Readonly<{
  binding: CodeBinding;
  mode: CodeMode;
  state: CodeState;
  destination: string;
  account: string | null;
  model: string | null;
  account_generation: number;
  context_hash: string;
  file_count: number;
  manifest: readonly FocusName[];
  hashes: readonly CodeHashRecord[];
  source_codepoints: number;
  diagnostics_codepoints: number;
  metadata_codepoints: number;
  expires_at: string;
  diagnostic: string | null;
  receipts: readonly CodeReceipt[];
  target?: FocusName | null;
}>;
export type CodeGrant = Readonly<{
  binding: CodeBinding;
  grant_boot_id: string;
  scope: CodeScope;
  operation_id: string;
  approved_hash: string;
  issued_at: string;
  expires_at: string;
  consumed_at?: string | null;
}>;
export type CodeIntent = Readonly<
  {
    binding: CodeBinding;
    operation_id: string;
    effect_id: string;
    ordinal: number;
    expected_hash: string;
  } & (
    | { scope: "code.create" | "code.replace"; target: FocusName }
    | { scope: "code.test"; recipe: TestRecipe }
  )
>;
export type TestRecipe = Readonly<{
  platform: "darwin" | "win32";
  executable: string;
  executable_identity: string;
  executable_hash: string;
  executable_version: string;
  argv: readonly [string, string, string, string];
  cwd: string;
  root_id: string;
  environment: Readonly<Record<string, string>>;
  file_hashes: readonly Readonly<{ name: FocusName; hash: string }>[];
  deadline: string;
  output_cap: 262144;
  recipe_hash: string;
}>;
export type CodeReview = Readonly<{
  binding: CodeBinding;
  scope: CodeScope;
  approved_hash: string;
  decision: "accept" | "reject";
}>;
export type CodeReviewResult =
  | Readonly<{ kind: "grant"; grant: CodeGrant }>
  | Readonly<{ kind: "job"; job: CodeJobView }>
  | Readonly<{ kind: "receipt"; receipt: CodeReceipt }>;
export type CodeAck = Readonly<{
  operation_id: string;
  effect_id: string;
  status: "recorded" | "duplicate" | "conflict";
  recorded_hash?: string | null;
}>;
export type CodePage = Readonly<{ limit?: number; offset?: number }>;
export type CodeJobPage = Readonly<{
  items: readonly CodeJobView[];
  next_offset: number | null;
}>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const FILE_STATUSES = [
  "created",
  "applied_saved",
  "applied_unsaved",
  "needs_review",
  "partial",
  "needs_reconciliation",
];
const TEST_STATUSES = [
  "passed",
  "failed",
  "cancelled",
  "changed_during_test",
  "unknown",
  "termination_unconfirmed",
];
const STATES = [
  "context_ready",
  "proposing",
  "review_required",
  "applying",
  "applied_saved",
  "applied_unsaved",
  "needs_review",
  "test_review",
  "testing",
  "completed",
  "rejected",
  "cancelled",
  "failed",
  "partial",
  "interrupted",
  "needs_reconciliation",
];
const DIAGNOSTICS = [
  "invalid_context",
  "stale_context",
  "provider_unavailable",
  "provider_error",
  "effect_failed",
  "test_failed",
  "interrupted",
  "expired",
  "reconciliation_required",
];
const TEST_ARGV = [
  "--test",
  "--test-isolation=none",
  "--test-reporter=tap",
  "focus.test.mjs",
] as const;
type Row = Record<string, unknown>;
function invalid(): never {
  throw new TypeError("Invalid coding contract");
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const row = value as Row;
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    invalid();
  return row;
}
function oneOf(value: unknown, values: readonly unknown[]): void {
  if (!values.includes(value)) invalid();
}
function integer(value: unknown, min = 0, max = MAX_SAFE): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
}
function string(
  value: unknown,
  max: number,
  controls = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    [...value].length > max ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    invalid();
  if (
    controls &&
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
  )
    invalid();
}
function id(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    invalid();
}
function hash(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
}
function nullable(value: unknown, check: (value: unknown) => void): void {
  if (value !== null) check(value);
}
function array(
  value: unknown,
  check: (value: unknown) => void,
  max: number,
): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  value.forEach(check);
}
function frame(value: unknown): void {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 1_048_576)
      invalid();
  } catch {
    invalid();
  }
}
function name(value: unknown): void {
  oneOf(value, FOCUS_NAMES);
}
function mode(value: unknown): void {
  oneOf(value, ["create_focus_project", "replace_focus_file"]);
}
function sourceText(value: unknown): void {
  string(value, 32000, true);
  if (value.startsWith("\ufeff") || value.includes("\r")) invalid();
}
function model(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)
  )
    invalid();
}
function utc(value: unknown): void {
  if (typeof value !== "string" || value.length > 27) invalid();
  const parts =
    /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{6}))?Z$/.exec(
      value,
    );
  if (!parts || parts[7] === "000000") invalid();
  const [year, month, day, hour, minute, second] = parts
    .slice(1, 7)
    .map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    invalid();
}
function unique(names: readonly unknown[]): void {
  if (new Set(names).size !== names.length) invalid();
}
function binding(value: unknown): void {
  const row = object(value, [
    "job_id",
    "boot_id",
    "pair_id",
    "window_id",
    "root_id",
    "revision",
    "policy_version",
  ]);
  for (const key of ["job_id", "boot_id", "pair_id", "window_id", "root_id"])
    id(row[key]);
  integer(row.revision, 1);
  oneOf(row.policy_version, ["code-v1"]);
}
function source(value: unknown): void {
  const row = object(value, ["name", "text"]);
  name(row.name);
  sourceText(row.text);
}
function file(value: unknown): void {
  const row = object(value, [
    "name",
    "text",
    "text_hash",
    "disk_hash",
    "document_version",
    "file_id",
  ]);
  name(row.name);
  sourceText(row.text);
  hash(row.text_hash);
  hash(row.disk_hash);
  integer(row.document_version);
  id(row.file_id);
}
export function parseCodeContext(value: unknown): CodeContext {
  frame(value);
  const row = object(
    value,
    ["binding", "mode", "root_uri", "root_file_id", "files", "context_hash"],
    ["diagnostics", "target"],
  );
  binding(row.binding);
  mode(row.mode);
  string(row.root_uri, 4096, true);
  if (!row.root_uri) invalid();
  id(row.root_file_id);
  hash(row.context_hash);
  array(row.files, file, 4);
  unique(row.files.map((item) => (item as Row).name));
  if (Object.hasOwn(row, "diagnostics"))
    array(row.diagnostics, (x) => string(x, 64000, true), 64000);
  const names = row.files.map((item) => (item as Row).name);
  if (row.mode === "create_focus_project") {
    if (names.length || Object.hasOwn(row, "target")) invalid();
  } else {
    if (
      names.length < 1 ||
      !Object.hasOwn(row, "target") ||
      !names.includes(row.target)
    )
      invalid();
    name(row.target);
  }
  const metadata =
    (row.mode as string).length +
    (typeof row.target === "string" ? row.target.length : 0);
  const total =
    (row.files as unknown[]).reduce<number>(
      (sum, item) =>
        sum +
        [...(item as CodeFile).name].length +
        [...(item as CodeFile).text].length,
      0,
    ) +
    ((row.diagnostics as string[] | undefined) ?? []).reduce(
      (sum, item) => sum + [...item].length,
      0,
    ) +
    metadata;
  if (total > 64000) invalid();
  return value as CodeContext;
}
function draft(value: unknown, start: boolean): void {
  const row = object(
    value,
    [
      "job_id",
      "revision",
      "account_generation",
      "user_text",
      "backend",
      ...(start ? ["disclosure_hash"] : []),
    ],
    ["model"],
  );
  id(row.job_id);
  integer(row.revision, 1);
  integer(row.account_generation, 1);
  string(row.user_text, 32000, true);
  oneOf(row.backend, ["copilot"]);
  if (Object.hasOwn(row, "model")) nullable(row.model, model);
  if (start) hash(row.disclosure_hash);
}
export function parseCodeDraft(value: unknown): CodeDraft {
  frame(value);
  draft(value, false);
  return value as CodeDraft;
}
export function parseCodeStart(value: unknown): CodeStart {
  frame(value);
  draft(value, true);
  return value as CodeStart;
}
export function parseCodeModelRequest(value: unknown): CodeModelRequest {
  frame(value);
  const row = object(
    value,
    [
      "job_id",
      "revision",
      "account_generation",
      "user_text",
      "backend",
      "disclosure_hash",
      "request_id",
      "deadline",
      "mode",
      "files",
    ],
    ["model", "diagnostics", "target"],
  );
  draft(
    Object.fromEntries(
      Object.entries(row).filter(
        ([key]) =>
          ![
            "request_id",
            "deadline",
            "mode",
            "files",
            "diagnostics",
            "target",
          ].includes(key),
      ),
    ),
    true,
  );
  id(row.request_id);
  utc(row.deadline);
  mode(row.mode);
  array(row.files, source, 4);
  const names = row.files.map((item) => (item as Row).name);
  unique(names);
  if (row.mode === "create_focus_project") {
    if (names.length || Object.hasOwn(row, "target")) invalid();
  } else {
    if (
      names.length < 1 ||
      !Object.hasOwn(row, "target") ||
      !names.includes(row.target)
    )
      invalid();
    name(row.target);
  }
  if (Object.hasOwn(row, "diagnostics"))
    array(row.diagnostics, (x) => string(x, 64000, true), 64000);
  const total =
    (row.files as unknown[]).reduce<number>(
      (sum, item) =>
        sum +
        [...(item as CodeSource).name].length +
        [...(item as CodeSource).text].length,
      0,
    ) +
    ((row.diagnostics as string[] | undefined) ?? []).reduce(
      (sum, item) => sum + [...item].length,
      0,
    ) +
    [...(row.mode as string)].length +
    (typeof row.target === "string" ? [...row.target].length : 0);
  if (total > 64000) invalid();
  return value as CodeModelRequest;
}
export function parseCodeProposal(
  value: unknown,
  context: CodeContext,
): CodeProposal {
  frame(value);
  const row = object(value, ["job_id", "revision", "explanation", "files"]);
  id(row.job_id);
  integer(row.revision, 1);
  string(row.explanation, 2000, true);
  array(row.files, source, 4);
  const names = row.files.map((item) => (item as Row).name);
  unique(names);
  if (
    names.length < 1 ||
    (row.files as unknown[]).reduce<number>(
      (sum, item) =>
        sum +
        [...(item as CodeSource).name].length +
        [...(item as CodeSource).text].length,
      0,
    ) > 64000
  )
    invalid();
  if (
    row.job_id !== context.binding.job_id ||
    row.revision !== context.binding.revision
  )
    invalid();
  if (context.mode === "create_focus_project") {
    if (names.length !== 4 || FOCUS_NAMES.some((item) => !names.includes(item)))
      invalid();
  } else if (names.length !== 1 || names[0] !== context.target) invalid();
  return value as CodeProposal;
}
export function providerContext(context: CodeContext): readonly CodeSource[] {
  return context.files.map((file) => ({ name: file.name, text: file.text }));
}
function receipt(value: unknown): void {
  const common = [
    "binding",
    "operation_id",
    "effect_id",
    "scope",
    "ordinal",
    "expected_hash",
    "status",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const scope = (value as Row).scope;
  if (scope === "code.test") {
    const row = object(
      value,
      [
        ...common,
        "environment_hash",
        "executable_hash",
        "executable_version",
        "cancel_requested",
        "timeout",
        "overflow",
      ],
      ["exit_code", "signal", "output_digest"],
    );
    oneOf(row.status, TEST_STATUSES);
    hash(row.environment_hash);
    hash(row.executable_hash);
    model(row.executable_version);
    if (Object.hasOwn(row, "exit_code"))
      nullable(row.exit_code, (x) => integer(x, -MAX_SAFE));
    if (Object.hasOwn(row, "signal"))
      nullable(row.signal, (x) => string(x, 32, true));
    if (Object.hasOwn(row, "output_digest")) nullable(row.output_digest, hash);
    for (const key of ["cancel_requested", "timeout", "overflow"])
      if (typeof row[key] !== "boolean") invalid();
  } else {
    const row = object(
      value,
      [...common, "target"],
      ["observed_hash", "observed_length"],
    );
    oneOf(row.scope, ["code.create", "code.replace"]);
    name(row.target);
    oneOf(row.status, FILE_STATUSES);
    if (row.scope === "code.create")
      oneOf(row.status, ["created", "partial", "needs_reconciliation"]);
    else
      oneOf(row.status, [
        "applied_saved",
        "applied_unsaved",
        "needs_review",
        "needs_reconciliation",
      ]);
    if (Object.hasOwn(row, "observed_hash")) nullable(row.observed_hash, hash);
    if (Object.hasOwn(row, "observed_length"))
      nullable(row.observed_length, (x) => integer(x));
  }
  const row = value as Row;
  binding(row.binding);
  id(row.operation_id);
  id(row.effect_id);
  integer(row.ordinal);
  hash(row.expected_hash);
}
export function parseCodeReceipt(value: unknown): CodeReceipt {
  frame(value);
  receipt(value);
  return value as CodeReceipt;
}
export function parseCodeJobView(value: unknown): CodeJobView {
  frame(value);
  const row = object(
    value,
    [
      "binding",
      "mode",
      "state",
      "destination",
      "account",
      "model",
      "account_generation",
      "context_hash",
      "file_count",
      "manifest",
      "hashes",
      "source_codepoints",
      "diagnostics_codepoints",
      "metadata_codepoints",
      "expires_at",
      "diagnostic",
      "receipts",
    ],
    ["target"],
  );
  binding(row.binding);
  mode(row.mode);
  oneOf(row.state, STATES);
  string(row.destination, 200, true);
  if (!row.destination) invalid();
  nullable(row.account, (x) => {
    string(x, 100, true);
    if (!x) invalid();
  });
  nullable(row.model, model);
  integer(row.account_generation, 1);
  hash(row.context_hash);
  integer(row.file_count, 0, 4);
  array(row.manifest, name, 4);
  unique(row.manifest);
  array(
    row.hashes,
    (item) => {
      const hashRow = object(item, [
        "name",
        "source_hash",
        "proposed_hash",
        "observed_hash",
      ]);
      name(hashRow.name);
      for (const key of ["source_hash", "proposed_hash", "observed_hash"])
        nullable(hashRow[key], hash);
    },
    4,
  );
  if (row.file_count !== row.manifest.length) invalid();
  const hashNames = row.hashes.map((item) => (item as Row).name);
  unique(hashNames);
  if (row.mode === "create_focus_project") {
    if (row.file_count !== 0 || Object.hasOwn(row, "target")) invalid();
    if (
      hashNames.length &&
      (hashNames.length !== 4 ||
        FOCUS_NAMES.some((item) => !hashNames.includes(item)) ||
        row.hashes.some((item) => (item as Row).source_hash !== null))
    )
      invalid();
  } else {
    if (row.file_count < 1 || !row.manifest.includes(row.target)) invalid();
    name(row.target);
    if (
      hashNames.length !== row.manifest.length ||
      hashNames.some((item, i) => item !== (row.manifest as unknown[])[i])
    )
      invalid();
  }
  for (const key of [
    "source_codepoints",
    "diagnostics_codepoints",
    "metadata_codepoints",
  ])
    integer(row[key]);
  if (
    (row.source_codepoints as number) +
      (row.diagnostics_codepoints as number) +
      (row.metadata_codepoints as number) >
    64000
  )
    invalid();
  utc(row.expires_at);
  nullable(row.diagnostic, (x) => oneOf(x, DIAGNOSTICS));
  array(row.receipts, receipt, 100);
  return value as CodeJobView;
}
export function parseCodeAck(value: unknown): CodeAck {
  frame(value);
  const row = object(
    value,
    ["operation_id", "effect_id", "status"],
    ["recorded_hash"],
  );
  id(row.operation_id);
  id(row.effect_id);
  oneOf(row.status, ["recorded", "duplicate", "conflict"]);
  if (row.status === "conflict") {
    if (Object.hasOwn(row, "recorded_hash") && row.recorded_hash !== null)
      invalid();
  } else hash(row.recorded_hash);
  return value as CodeAck;
}
export function parseTestRecipe(value: unknown): TestRecipe {
  frame(value);
  const row = object(value, [
    "platform",
    "executable",
    "executable_identity",
    "executable_hash",
    "executable_version",
    "argv",
    "cwd",
    "root_id",
    "environment",
    "file_hashes",
    "deadline",
    "output_cap",
    "recipe_hash",
  ]);
  oneOf(row.platform, ["darwin", "win32"]);
  string(row.executable, 4096, true);
  if (
    !row.executable ||
    !(row.platform === "darwin"
      ? row.executable.startsWith("/")
      : /^[A-Za-z]:\\/.test(row.executable))
  )
    invalid();
  id(row.executable_identity);
  hash(row.executable_hash);
  model(row.executable_version);
  array(row.argv, (item) => string(item, 100, true), 4);
  if (
    row.argv.length !== 4 ||
    TEST_ARGV.some((item, i) => item !== (row.argv as unknown[])[i])
  )
    invalid();
  string(row.cwd, 4096, true);
  if (
    !row.cwd ||
    !(row.platform === "darwin"
      ? row.cwd.startsWith("/")
      : /^[A-Za-z]:\\/.test(row.cwd))
  )
    invalid();
  id(row.root_id);
  if (
    !row.environment ||
    typeof row.environment !== "object" ||
    Array.isArray(row.environment)
  )
    invalid();
  const environment = row.environment as Row;
  const keys = Object.keys(environment);
  const allowed = [
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
  ];
  if (
    keys.some((key) => !allowed.includes(key)) ||
    new Set(keys.map((key) => key.toUpperCase())).size !== keys.length ||
    environment.PATH !== ""
  )
    invalid();
  for (const key of keys) string(environment[key], 4096, true);
  for (const key of ["TEMP", "TMP", "TMPDIR"]) if (!environment[key]) invalid();
  const identity = [
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOGONSERVER",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
  ];
  if (row.platform === "darwin") {
    if (identity.some((key) => Object.hasOwn(environment, key))) invalid();
  } else if (identity.some((key) => environment[key] !== "")) invalid();
  array(
    row.file_hashes,
    (item) => {
      const file = object(item, ["name", "hash"]);
      name(file.name);
      hash(file.hash);
    },
    4,
  );
  if (
    row.file_hashes.length !== 4 ||
    FOCUS_NAMES.some(
      (item, i) => ((row.file_hashes as unknown[])[i] as Row).name !== item,
    )
  )
    invalid();
  utc(row.deadline);
  oneOf(row.output_cap, [262144]);
  hash(row.recipe_hash);
  return value as TestRecipe;
}
export function parseCodeIntent(value: unknown): CodeIntent {
  frame(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const scope = (value as Row).scope;
  const common = [
    "binding",
    "operation_id",
    "effect_id",
    "scope",
    "ordinal",
    "expected_hash",
  ];
  const row =
    scope === "code.test"
      ? object(value, [...common, "recipe"])
      : object(value, [...common, "target"]);
  binding(row.binding);
  id(row.operation_id);
  id(row.effect_id);
  integer(row.ordinal);
  hash(row.expected_hash);
  if (scope === "code.test") parseTestRecipe(row.recipe);
  else {
    oneOf(scope, ["code.create", "code.replace"]);
    name(row.target);
  }
  return value as CodeIntent;
}
export function parseCodeReview(value: unknown): CodeReview {
  frame(value);
  const row = object(value, ["binding", "scope", "approved_hash", "decision"]);
  binding(row.binding);
  oneOf(row.scope, ["code.create", "code.replace", "code.test"]);
  hash(row.approved_hash);
  oneOf(row.decision, ["accept", "reject"]);
  return value as CodeReview;
}
export function parseCodeGrant(value: unknown): CodeGrant {
  frame(value);
  const row = object(
    value,
    [
      "binding",
      "grant_boot_id",
      "scope",
      "operation_id",
      "approved_hash",
      "issued_at",
      "expires_at",
    ],
    ["consumed_at"],
  );
  binding(row.binding);
  id(row.grant_boot_id);
  oneOf(row.scope, ["code.create", "code.replace", "code.test"]);
  id(row.operation_id);
  hash(row.approved_hash);
  utc(row.issued_at);
  utc(row.expires_at);
  if (Object.hasOwn(row, "consumed_at")) nullable(row.consumed_at, utc);
  return value as CodeGrant;
}
export function parseCodeReviewResult(value: unknown): CodeReviewResult {
  frame(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const kind = (value as Row).kind;
  if (kind === "grant") parseCodeGrant(object(value, ["kind", "grant"]).grant);
  else if (kind === "job") parseCodeJobView(object(value, ["kind", "job"]).job);
  else if (kind === "receipt")
    parseCodeReceipt(object(value, ["kind", "receipt"]).receipt);
  else invalid();
  return value as CodeReviewResult;
}
export function parseCodePage(value: unknown): CodePage {
  const row = object(value, [], ["limit", "offset"]);
  if (Object.hasOwn(row, "limit")) integer(row.limit, 1, 100);
  if (Object.hasOwn(row, "offset")) integer(row.offset, 0, 1_000_000);
  return value as CodePage;
}
export function parseCodeJobPage(value: unknown): CodeJobPage {
  frame(value);
  const row = object(value, ["items", "next_offset"]);
  array(row.items, parseCodeJobView, 100);
  nullable(row.next_offset, (x) => integer(x, 0, 1_000_000));
  return value as CodeJobPage;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") invalid();
  const row = value as Row;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
    .join(",")}}`;
}
async function digest(value: unknown): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function contextHash(context: CodeContext): Promise<string> {
  const valid = parseCodeContext(context);
  return digest({
    binding: valid.binding,
    mode: valid.mode,
    root_uri: valid.root_uri,
    root_file_id: valid.root_file_id,
    files: valid.files,
    diagnostics: valid.diagnostics ?? [],
    target: valid.target ?? null,
    lengths: {
      root_uri: [...valid.root_uri].length,
      files: valid.files.map((file) => ({
        name: [...file.name].length,
        text: [...file.text].length,
      })),
      diagnostics: (valid.diagnostics ?? []).map((item) => [...item].length),
    },
  });
}
export async function disclosureHash(
  view: CodeJobView,
  draftValue: CodeDraft,
): Promise<string> {
  const draft = parseCodeDraft(draftValue);
  if (
    draft.job_id !== view.binding.job_id ||
    draft.revision !== view.binding.revision ||
    draft.account_generation !== view.account_generation ||
    (draft.model ?? null) !== view.model
  )
    invalid();
  const material = {
    context_hash: view.context_hash,
    user_text: draft.user_text,
    revision: draft.revision,
    backend: draft.backend,
    model: draft.model ?? null,
    destination: view.destination,
    account: view.account,
    account_generation: draft.account_generation,
    lengths: {
      context_hash: [...view.context_hash].length,
      user_text: [...draft.user_text].length,
      destination: [...view.destination].length,
      account: [...(view.account ?? "")].length,
      model: [...(draft.model ?? "")].length,
    },
  };
  return digest(material);
}
export async function recipeHash(recipe: TestRecipe): Promise<string> {
  const valid = parseTestRecipe(recipe);
  const material = Object.fromEntries(
    Object.entries(valid).filter(([key]) => key !== "recipe_hash"),
  );
  const lengths = {
    executable: [...valid.executable].length,
    cwd: [...valid.cwd].length,
    argv: valid.argv.map((item) => [...item].length),
    environment: Object.fromEntries(
      Object.entries(valid.environment).map(([key, value]) => [
        key,
        [...value].length,
      ]),
    ),
  };
  return digest({ ...material, lengths });
}
