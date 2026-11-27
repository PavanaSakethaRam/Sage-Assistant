/** Native workbench controls drive product confirmation; no product test-only API. */
import { createHash } from "node:crypto";
import { strict as assert } from "node:assert";
import type { Page } from "@playwright/test";
import { EditorBridgeHost } from "../../../desktop/main/editor-bridge";
import type {
  ContextOffer,
  PairView,
} from "../../../desktop/shared/editor-bridge";
export async function pairThroughWorkbench(
  page: Page,
  capture = false,
): Promise<{
  close(): Promise<void>;
  assertDisconnected(): Promise<void>;
  exerciseContext(): Promise<void>;
}> {
  let view: PairView | undefined;
  const offers: ContextOffer[] = [];
  const host = new EditorBridgeHost({
    onData: (data) => {
      if (capture && data.kind === "context.offer") {
        offers.push(data.payload);
        return;
      }
      throw Error("Pairing released unexpected data");
    },
    onPair: (value) => {
      view = value;
    },
  });
  try {
    const ticket = await host.start();
    const input = page.getByPlaceholder("Sage pairing ticket", { exact: true });
    await input.waitFor({ timeout: 20_000 });
    await input.fill(Buffer.from(JSON.stringify(ticket)).toString("base64url"));
    await input.press("Enter");
    await page
      .getByRole("button", { name: "Pair this folder", exact: true })
      .waitFor({ timeout: 20_000 });
    assert.ok(view);
    assert.ok(
      await page
        .getByText(`Challenge: ${view.challenge}`, { exact: false })
        .count(),
    );
    await page
      .getByRole("button", { name: "Pair this folder", exact: true })
      .click();
    const paired = await host.confirm(view.pair_id);
    assert.equal(paired.status, "paired");
    const binding = {
      job_id: "native-reload-probe",
      boot_id: paired.host_boot_id,
      pair_id: paired.pair_id,
      window_id: paired.window_id,
      root_id: paired.root_id,
      revision: 1,
      policy_version: "code-v1" as const,
    };
    return {
      close: () => host.close(),
      exerciseContext: async () => {
        assert.equal(offers.length, 0);
        const mode = page.getByPlaceholder("Sage: Choose context mode", {
          exact: true,
        });
        await mode.waitFor({ timeout: 20000 });
        await mode.fill("Replace one focus file");
        await mode.press("Enter");
        const target = page.getByPlaceholder(
          "Sage: Choose replacement target",
          { exact: true },
        );
        await target.waitFor({ timeout: 20000 });
        await target.fill("focus.js");
        await target.press("Enter");
        const extra = page.getByPlaceholder(
          "Sage: Select 0–3 additional read-only manifest files",
          { exact: true },
        );
        await extra.waitFor({ timeout: 20000 });
        await extra.press("Enter");
        const diagnostics = page.getByPlaceholder(
          "Sage: Optional selected diagnostics",
          { exact: true },
        );
        await diagnostics.waitFor({ timeout: 20000 });
        await diagnostics.fill("No diagnostics");
        await diagnostics.press("Enter");
        const send = page.getByPlaceholder(
          "Sage: Confirm selected disclosure",
          { exact: true },
        );
        await send.waitFor({ timeout: 20000 });
        const confirmation = page
          .locator(".quick-input-widget")
          .filter({ has: send });
        assert.equal(offers.length, 0);
        const fileHash = createHash("sha256")
          .update("export const nativeMarker = '😀';\n")
          .digest("hex");
        const visibleParts: string[] = [];
        for (const part of [1, 2]) {
          await send.fill(`Context SHA256 (${part}/2):`);
          const label = confirmation
            .getByText(
              new RegExp(`^Context SHA256 \\(${part}/2\\): [0-9a-f]{32}$`),
            )
            .first();
          await label.waitFor({ timeout: 10000 });
          visibleParts.push((await label.innerText()).split(": ")[1]);
        }
        const expected = [
          "Mode: replace_focus_file",
          "Selected manifest (1 existing): focus.js",
          "Target: focus.js",
          "Read-only scope: none",
          `Context SHA256 (1/2): ${visibleParts[0]}`,
          `Context SHA256 (2/2): ${visibleParts[1]}`,
          "focus.js source: 33 code points",
          `focus.js text SHA256 (1/2): ${fileHash.slice(0, 32)}`,
          `focus.js text SHA256 (2/2): ${fileHash.slice(32)}`,
          `focus.js disk SHA256 (1/2): ${fileHash.slice(0, 32)}`,
          `focus.js disk SHA256 (2/2): ${fileHash.slice(32)}`,
          "Source: 33 code points",
          "Selected diagnostics: 0 code points (0 selected)",
          "Provider-visible metadata: 34 code points",
          "Total: 67 / 64000 code points",
        ];
        for (const line of expected) {
          await send.fill(line);
          const item = confirmation.getByText(line, { exact: true }).first();
          await item.waitFor({ timeout: 10000 });
          await item.scrollIntoViewIfNeeded();
          assert.equal(await item.isVisible(), true);
        }
        assert.equal(offers.length, 0);
        await send.fill("Send selected context to local Sage");
        await send.press("Enter");
        const until = Date.now() + 20000;
        while (!offers.length && Date.now() < until)
          await new Promise((r) => setTimeout(r, 20));
        assert.equal(offers.length, 1);
        assert.equal(offers[0].context.mode, "replace_focus_file");
        assert.equal(offers[0].context.files.length, 1);
        assert.equal(visibleParts.join(""), offers[0].context.context_hash);
        assert.equal(offers[0].context.target, "focus.js");
        assert.equal(offers[0].context.files[0].text_hash, fileHash);
        assert.equal(offers[0].context.files[0].disk_hash, fileHash);
        console.log(
          JSON.stringify({
            confirmation_summary_checked: true,
            visible_summary: expected,
            confirmed_context_hash: offers[0].context.context_hash,
          }),
        );
        assert.equal(
          offers[0].context.files[0].text,
          "export const nativeMarker = '😀';\n",
        );
        assert.equal(
          offers[0].expires_at_ms - offers[0].captured_at_ms,
          1800000,
        );
      },
      assertDisconnected: async () => {
        let refused = false;
        try {
          await host.send({ kind: "revoke", binding, payload: null });
        } catch {
          refused = true;
        }
        assert.equal(refused, true, "Old pairing survived native reload");
      },
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        host_authenticated: !!view,
        workbench: (await page.locator("body").innerText()).slice(0, 6000),
      }),
    );
    await host.close();
    throw error;
  }
}

export { createThroughWorkbench } from "./create";

export { replaceThroughWorkbench } from "./replace";
