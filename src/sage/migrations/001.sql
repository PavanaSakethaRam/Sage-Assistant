CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data_json TEXT NOT NULL CHECK (json_valid(data_json))
);
CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE revisions (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    tool TEXT NOT NULL CHECK (tool = 'notes.create'),
    scope TEXT NOT NULL CHECK (scope = 'notes'),
    title TEXT,
    body TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, revision),
    UNIQUE (id, revision),
    CHECK ((title IS NULL) = (body IS NULL))
);
CREATE TABLE approvals (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    proposal_id TEXT NOT NULL,
    tool TEXT NOT NULL CHECK (tool = 'notes.create'),
    arguments_title TEXT,
    arguments_body TEXT,
    arguments_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK (scope = 'notes'),
    policy_version TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('pending', 'approved', 'rejected')),
    boot_id TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (proposal_id, revision) REFERENCES revisions(id, revision) ON DELETE CASCADE,
    CHECK ((arguments_title IS NULL) = (arguments_body IS NULL))
);
CREATE TABLE notes (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task_id TEXT
);
CREATE TABLE operations (
    id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    proposal_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
    approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN (
        'pending', 'succeeded', 'failed', 'cancelled', 'rejected', 'needs_reconciliation'
    )),
    note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
    diagnostic TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX tasks_retention ON tasks(updated_at);
CREATE INDEX revisions_retention ON revisions(created_at);
CREATE INDEX approvals_task ON approvals(task_id);
CREATE INDEX operations_task ON operations(task_id);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
CREATE TRIGGER notes_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER notes_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER notes_update AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, body)
        VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER cancelled_task_scrub AFTER UPDATE OF status ON tasks
WHEN new.status IN ('cancelled', 'rejected') BEGIN
    UPDATE revisions SET title = NULL, body = NULL WHERE task_id = new.id;
    UPDATE approvals SET arguments_title = NULL, arguments_body = NULL WHERE task_id = new.id;
END;
CREATE TRIGGER rejected_approval_scrub AFTER UPDATE OF decision ON approvals
WHEN new.decision = 'rejected' BEGIN
    UPDATE approvals SET arguments_title = NULL, arguments_body = NULL
        WHERE proposal_id = new.proposal_id AND revision = new.revision;
    UPDATE revisions SET title = NULL, body = NULL
        WHERE id = new.proposal_id AND revision = new.revision;
END;
