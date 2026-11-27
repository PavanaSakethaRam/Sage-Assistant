CREATE TABLE coding_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
        'context_ready','proposing','review_required','applying','applied_saved',
        'applied_unsaved','needs_review','test_review','testing','completed',
        'rejected','cancelled','failed','partial','interrupted','needs_reconciliation'
    )),
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    view_json TEXT NOT NULL CHECK (json_valid(view_json)),
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_active_coding_job ON coding_jobs(active) WHERE active=1;
CREATE INDEX coding_retention ON coding_jobs(updated_at);
CREATE TABLE coding_grants (
    operation_id TEXT PRIMARY KEY NOT NULL,
    job_id TEXT NOT NULL REFERENCES coding_jobs(id) ON DELETE CASCADE,
    grant_boot_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('code.create','code.replace','code.test')),
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
    consumed_at TEXT
);
CREATE TABLE coding_effects (
    effect_id TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL REFERENCES coding_grants(operation_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 3),
    scope TEXT NOT NULL CHECK (scope IN ('code.create','code.replace','code.test')),
    intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    intent_hash TEXT NOT NULL,
    expected_length INTEGER CHECK (expected_length IS NULL OR expected_length BETWEEN 0 AND 128000),
    receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
    receipt_hash TEXT,
    UNIQUE(operation_id,ordinal),
    CHECK ((receipt_json IS NULL) = (receipt_hash IS NULL))
);
