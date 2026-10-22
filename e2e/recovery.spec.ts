import { test, expect } from "@playwright/test";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
  launch,
  close,
  createDraft,
  database,
  python,
  waitEvent,
} from "./harness";

test("SQLITE_FULL and a real locked database retain drafts and recover without resets", async () => {
  const host = await launch();
  try {
    await createDraft(host, "Sentinel", "preserve exact sentinel");
    await host.page
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(
      host.page.getByLabel("Saved body", { exact: true }),
    ).toHaveText("preserve exact sentinel");
    const sentinel = (await database(host)).notes;
    await createDraft(host, "After full", "retained after full");
    await writeFile(join(host.root, "userData/full.once"), "1");
    await host.page
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await waitEvent(host, "sqlite_full");
    await expect(host.page.getByLabel("Note review status")).toContainText(
      "failed",
    );
    expect((await database(host)).notes).toEqual(sentinel);
    await host.page
      .getByRole("button", { name: "Review again", exact: true })
      .click();
    await host.page
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(
      host.page.getByLabel("Saved body", { exact: true }),
    ).toHaveText("retained after full");
    await createDraft(host, "After lock", "retained after lock");
    const locker = spawn(
      python,
      [
        "-I",
        "-c",
        "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('BEGIN IMMEDIATE'); print('locked',flush=True); sys.stdin.readline(); c.rollback(); c.close()",
        join(host.root, "userData/data/sage.sqlite3"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await new Promise<void>((done, reject) => {
        locker.stdout.once("data", () => done());
        locker.once("error", reject);
      });
      await host.page
        .getByRole("button", { name: "Save note", exact: true })
        .click();
      await expect(host.page.getByLabel("Note review status")).toContainText(
        "failed",
      );
    } finally {
      const exited = new Promise<void>((done) =>
        locker.once("close", () => done()),
      );
      locker.stdin.end("release\n");
      await exited;
    }
    expect((await database(host)).notes).toEqual([
      ...sentinel,
      { title: "After full", body: "retained after full" },
    ]);
    await host.page
      .getByRole("button", { name: "Review again", exact: true })
      .click();
    await host.page
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(
      host.page.getByLabel("Saved body", { exact: true }),
    ).toHaveText("retained after lock");
    expect((await database(host)).operations).toBe(3);
  } finally {
    await close(host);
  }
});

test("migration startup failure preserves schema/content and recovers on owned app restart", async () => {
  let host = await launch();
  const root = host.root;
  try {
    await createDraft(
      host,
      "Migration sentinel",
      "sentinel before migration failure",
    );
    await host.page
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(
      host.page.getByLabel("Saved body", { exact: true }),
    ).toHaveText("sentinel before migration failure");
    const before = await database(host);
    await close(host, false);
    await writeFile(join(root, "userData/migration.fail"), "1");
    host = await launch(root);
    await expect(host.page.getByLabel("Setup status")).toContainText(
      "unavailable",
    );
    await waitEvent(host, "migration_failed");
    expect(await database(host)).toEqual(before);
    expect(
      execFileSync(
        python,
        [
          "-I",
          "-c",
          "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA user_version').fetchone()[0])",
          join(root, "userData/data/sage.sqlite3"),
        ],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("1");
    await close(host, false);
    await rm(join(root, "userData/migration.fail"));
    host = await launch(root);
    await expect(host.page.getByText("Actual mode: local")).toBeVisible();
    await host.page
      .getByRole("button", { name: "Migration sentinel", exact: true })
      .click();
    await expect(host.page.getByLabel("Saved note literal body")).toHaveText(
      "sentinel before migration failure",
    );
    expect(await database(host)).toEqual(before);
  } finally {
    await close(host);
  }
});
