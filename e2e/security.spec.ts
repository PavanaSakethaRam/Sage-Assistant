import { test, expect } from "@playwright/test";
import type { CoreRequest } from "../desktop/shared/contracts";
import { createServer } from "node:http";
import {
  launch,
  close,
  createDraft,
  database,
  assistant,
  events,
} from "./harness";

test("hostile Markdown creates no attempts or egress; explicit links are validated; both IPC boundaries reject invalid input", async () => {
  let reached = 0;
  const server = createServer((_request, response) => {
    reached++;
    response.end("synthetic");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("sink unavailable");
  const sink = `http://127.0.0.1:${address.port}/leak`;
  const host = await launch();
  try {
    const attempted: string[] = [];
    host.page.on("request", (request) => {
      if (!request.url().startsWith("file:")) attempted.push(request.url());
    });
    await host.page.evaluate(() => {
      Object.assign(window, { __violations: 0 });
      document.addEventListener("securitypolicyviolation", () => {
        (window as unknown as { __violations: number }).__violations++;
      });
    });
    const markdown = `# Ordinary\n**bold**\n![remote](${sink})\n![reference][image]\n[image]: ${sink}\n<script>fetch('${sink}')</script>\n<svg onload="fetch('${sink}')"></svg>\n<iframe src="${sink}"></iframe><object data="${sink}"></object><embed src="${sink}"><form action="${sink}"><input></form>\n<style>body{background:url(${sink})}</style>\n\n[script](javascript:alert(1)) [data](data:text/html,x) [file](file:///etc/passwd) [relative](//evil.test/x)\n\n[normal](https://example.com/) <https://example.org/>`;
    await createDraft(host, "Hostile", markdown);
    const preview = host.page.locator(".markdown").first();
    await expect(preview.locator("strong")).toHaveText("bold");
    await expect(
      preview.locator(
        "script,iframe,object,embed,form,input,img,svg,style,video,audio,source,link,[onload],[onclick],a[href]",
      ),
    ).toHaveCount(0);
    expect(await preview.locator("[style]").count()).toBe(0);
    await host.page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    expect(attempted).toEqual([]);
    expect(reached).toBe(0);
    const before = await host.app.evaluate(() => {
      const e = (
        globalThis as unknown as {
          __sageE2E: {
            guardInstalled: boolean;
            requests: unknown[];
            external: string[];
          };
        }
      ).__sageE2E;
      return {
        guard: e.guardInstalled,
        requests: e.requests,
        external: e.external,
      };
    });
    expect(before).toEqual({ guard: true, requests: [], external: [] });
    const originalUrl = host.page.url();
    await preview
      .getByRole("button", { name: "Open external link: normal", exact: true })
      .click();
    expect(
      await host.app.evaluate(
        () =>
          (globalThis as unknown as { __sageE2E: { external: string[] } })
            .__sageE2E.external,
      ),
    ).toEqual(["https://example.com/"]);
    expect(host.page.url()).toBe(originalUrl);
    expect(host.app.windows()).toHaveLength(1);
    expect(
      await host.page.evaluate(async () => {
        try {
          await window.sage.request({
            version: 1,
            id: "invalid",
            kind: "request",
            method: "settings.get",
            params: { executable: "/evil" },
          } as unknown as CoreRequest);
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    const wrong = await host.app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const e = (
        globalThis as unknown as {
          __sageE2E: {
            handlers: Map<string, (event: unknown, value: unknown) => unknown>;
          };
        }
      ).__sageE2E;
      return e.handlers.get("sage:request")!(
        { sender: w.webContents, senderFrame: { url: w.webContents.getURL() } },
        {
          version: 1,
          id: "forged",
          kind: "request",
          method: "notes.propose",
          params: { title: "forged", body: "forged" },
        },
      );
    });
    expect(wrong).toMatchObject({ kind: "error", code: "invalid_request" });
    expect((await database(host)).notes).toEqual([]);
    expect(
      (await events(host)).filter((e) => e.event === "effect_attempt"),
    ).toEqual([]);
    // A positive request-attempt control proves the observer is active; CSP blocks it.
    expect(
      await host.page.evaluate(
        async (url) =>
          fetch(url).then(
            () => false,
            () => true,
          ),
        sink,
      ),
    ).toBe(true);
    // Chromium rejects this at CSP before its request event; violations observe that attempt.
    expect(attempted).toEqual([]);
    expect(
      await host.page.evaluate(
        () => (window as unknown as { __violations: number }).__violations,
      ),
    ).toBeGreaterThan(0);
    // Electron's own session fetch bypasses document CSP, exercising the retained deny handler.
    expect(
      await host.app.evaluate(
        async ({ BrowserWindow }, url) =>
          BrowserWindow.getAllWindows()[0]
            .webContents.session.fetch(url)
            .then(
              () => false,
              () => true,
            ),
        sink,
      ),
    ).toBe(true);
    expect(
      await host.app.evaluate(
        () =>
          (
            globalThis as unknown as {
              __sageE2E: { requests: { url: string; cancel: boolean }[] };
            }
          ).__sageE2E.requests,
      ),
    ).toContainEqual({ url: sink, cancel: true });
    expect(reached).toBe(0);
    // The owned sink itself responds: a positive actual-egress control, outside Sage.
    const control = await fetch(sink);
    await control.text();
    expect(reached).toBe(1);
    await assistant(host);
    await host.rpc("reasoning.start", {
      backend: "copilot",
      user_text: "egress_probe",
    });
    expect(
      (await events(host)).filter((e) => e.event === "forbidden_egress"),
    ).toHaveLength(1);
  } finally {
    await close(host);
    await new Promise<void>((done) => server.close(() => done()));
  }
});
