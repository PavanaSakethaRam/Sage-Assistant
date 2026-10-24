import { app } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";
import assert from "node:assert/strict";
// This is a separate un-fused test harness. The production entry remains unchanged.
app.setPath("userData", process.argv[2]);
app.on("browser-window-created", (_event, window) => {
  window.on("show", () => window.hide());
  window.webContents.once("did-finish-load", () => {
    void (async () => {
      assert.deepEqual(
        await window.webContents.executeJavaScript("Object.keys(window.sage)"),
        ["request", "onProgress"],
      );
      assert.equal(
        await window.webContents.executeJavaScript("typeof require"),
        "undefined",
      );
      assert.equal(
        await window.webContents.executeJavaScript("typeof process"),
        "undefined",
      );
      const response = await window.webContents.executeJavaScript(
        `window.sage.request({version:1,id:'smoke',kind:'request',method:'settings.get',params:{}})`,
      );
      assert.deepEqual(response, {
        version: 1,
        id: "smoke",
        kind: "response",
        result: {
          ai_mode: "local",
          reasoning_backend: null,
          coding_backend: "none",
          coding_model: null,
        },
      });
      assert.equal(
        await window.webContents.executeJavaScript(
          `window.sage.request({version:1,id:'bad',kind:'request',method:'settings.get',params:{executable:'/evil'}}).then(()=>false,()=>true)`,
        ),
        true,
      );
      assert.equal(
        await window.webContents.executeJavaScript(
          `window.sage.request({version:1,id:'private',kind:'host_coding',host_boot_id:'${"b".repeat(32)}',generation:1,operation:'revoke_pair',params:{pair_id:'pair'}}).then(()=>false,()=>true)`,
        ),
        true,
      );
      assert.equal(
        await window.webContents.executeJavaScript(
          `fetch('https://example.com/').then(()=>false,()=>true)`,
        ),
        true,
      );
      console.log("SAGE_HOST_SMOKE_OK");
      window.destroy();
    })().catch(() => {
      console.error("host_smoke_failed");
      app.exit(1);
    });
  });
});
createRequire(join(process.argv[3], "package.json"))(
  join(process.argv[3], ".vite/build/main.cjs"),
);
