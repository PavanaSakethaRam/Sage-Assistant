/** Native workbench controls drive product confirmation; no product test-only API. */
import { strict as assert } from "node:assert";
import type { Page } from "@playwright/test";
import { EditorBridgeHost } from "../../../desktop/main/editor-bridge";
import type { PairView } from "../../../desktop/shared/editor-bridge";
export async function pairThroughWorkbench(
  page: Page,
): Promise<{ close(): Promise<void>; assertDisconnected(): Promise<void> }> {
  let view: PairView | undefined;
  const host = new EditorBridgeHost({
    onData: () => {
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
