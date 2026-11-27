/** Explicit test values; production modules never import these. */
export const HASH = "a".repeat(64);
export const BINDING = {
  job_id: "job-1",
  boot_id: "boot-1",
  pair_id: "pair-1",
  window_id: "window-1",
  root_id: "root-1",
  revision: 1,
  policy_version: "code-v1",
};

export const makeFile = (overrides: Record<string, unknown> = {}) => ({
  name: "index.html",
  text: "<main>Focus</main>\n",
  text_hash: HASH,
  disk_hash: HASH,
  document_version: 1,
  file_id: "file-1",
  ...overrides,
});

export const makeContext = (overrides: Record<string, unknown> = {}) => ({
  binding: { ...BINDING },
  mode: "create_focus_project",
  root_uri: "file:///private/owner-marker/focus",
  root_file_id: "root-file-1",
  files: [],
  context_hash: HASH,
  ...overrides,
});

export const makeProposal = (overrides: Record<string, unknown> = {}) => ({
  job_id: "job-1",
  revision: 1,
  explanation: "A simple focus tracker.",
  files: [
    { name: "index.html", text: "<main>Focus</main>\n" },
    { name: "focus.js", text: "export const focus = true;\n" },
    { name: "focus.test.mjs", text: "import { test } from 'node:test';\n" },
    { name: "README.md", text: "# Focus\n" },
  ],
  ...overrides,
});

export const makeReceipt = (overrides: Record<string, unknown> = {}) => ({
  binding: { ...BINDING },
  operation_id: "operation-1",
  effect_id: "effect-1",
  scope: "code.create",
  target: "index.html",
  ordinal: 0,
  expected_hash: HASH,
  status: "created",
  observed_hash: HASH,
  observed_length: 12,
  ...overrides,
});
