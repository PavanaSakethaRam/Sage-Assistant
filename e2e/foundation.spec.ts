import { test, expect } from "@playwright/test";
import {
  launch,
  close,
  createDraft,
  database,
  assistant,
  waitEvent,
  events,
} from "./harness";
test("real host reviews, edits, saves once, cancels and reads exact content after restart", async () => {
  const host = await launch();
  try {
    expect(
      await host.page.evaluate(() => [
        typeof window.sage.request,
        typeof (window as unknown as { require?: unknown }).require,
        typeof (window as unknown as { process?: unknown }).process,
      ]),
    ).toEqual(["function", "undefined", "undefined"]);
    await expect(host.page.getByText("Actual mode: local")).toBeVisible();
    await createDraft(host, "Exact é", "Body\t**literal**\nsecond line");
    expect((await database(host)).notes).toEqual([]);
    await host.page
      .getByRole("button", { name: "Edit draft", exact: true })
      .click();
    await host.page
      .getByRole("textbox", { name: "Note body", exact: true })
      .fill("Edited\t**literal**\nsecond line");
    await host.page
      .getByRole("button", { name: "Review note", exact: true })
      .click();
    await expect(
      host.page.getByText(/Pending draft · revision 2/),
    ).toBeVisible();
    await host.page
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await expect(
      host.page.getByLabel("Saved body", { exact: true }),
    ).toHaveText("Edited\t**literal**\nsecond line", { useInnerText: false });
    const saved = await database(host);
    expect(saved.notes).toEqual([
      { title: "Exact é", body: "Edited\t**literal**\nsecond line" },
    ]);
    expect(saved.operations).toBe(1);
    expect(
      (await events(host)).filter((e) => e.event === "effect_attempt"),
    ).toHaveLength(1);
    await createDraft(host, "Cancel me", "do not save");
    await host.page
      .getByRole("button", { name: "Cancel draft", exact: true })
      .click();
    await expect(
      host.page.getByRole("heading", { name: "Note review", exact: true }),
    ).toHaveCount(0);
    expect((await database(host)).notes).toEqual(saved.notes);
    await close(host, false);
    const restarted = await launch(host.root);
    try {
      await restarted.page
        .getByRole("button", { name: "Exact é", exact: true })
        .click();
      await expect(
        restarted.page.getByLabel("Saved note literal body"),
      ).toHaveText("Edited\t**literal**\nsecond line", { useInnerText: false });
      expect((await database(restarted)).operations).toBe(1);
    } finally {
      await close(restarted);
    }
  } finally {
    await close(host);
  }
});

test("synthetic provider proposal, quota, crash restart, local rejection and cancelled late completion", async () => {
  const host = await launch();
  try {
    await assistant(host);
    await host.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("proposal");
    await host.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(host.page.getByLabel("Literal note title")).toHaveText(
      "Provider draft",
    );
    expect((await database(host)).notes).toEqual([]);
    await host.page
      .getByRole("button", { name: "Cancel draft", exact: true })
      .click();
    await host.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("quota");
    await host.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(host.page.getByLabel("Conversation status")).toHaveText(
      "error",
    );
    await expect(
      host.page.locator(".markdown p").filter({ hasText: "quota_exceeded" }),
    ).toBeVisible();
    await host.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("late");
    await host.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await waitEvent(host, "late_started");
    await host.page
      .getByRole("button", { name: "Cancel response", exact: true })
      .click();
    await waitEvent(host, "late_finished");
    await expect(host.page.getByLabel("Conversation status")).toContainText(
      "cancelled",
    );
    expect((await database(host)).notes).toEqual([]);
    expect((await database(host)).revisions).toBe(0);
    await host.page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("crash");
    await host.page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(host.page.getByLabel("Conversation status")).toContainText(
      "internal_error",
    );
    await host.page.getByRole("radio", { name: "Local AI only" }).click();
    await expect(host.page.getByText("Actual mode: local")).toBeVisible();
    expect((await database(host)).notes).toEqual([]);
    const local = await host.rpc("reasoning.start", {
      backend: "copilot",
      user_text: "local-forbidden",
    });
    expect(local).toMatchObject({ result: { status: "unavailable" } });
    await waitEvent(host, "started", 2);
    expect(
      (await events(host)).filter((e) =>
        ["effect_attempt", "forbidden_egress"].includes(e.event),
      ),
    ).toEqual([]);
    expect(
      (await events(host)).filter((e) => e.event === "provider_call"),
    ).toHaveLength(4);
  } finally {
    await close(host);
  }
});
