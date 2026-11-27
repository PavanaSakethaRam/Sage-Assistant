import { expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer } from "vite";
import renderer from "../../vite.renderer.config";
it("serves development without a conflicting meta policy and retains strict packaged HTML", async () => {
  const root = await mkdtemp(join(tmpdir(), "sage-renderer-build-"));
  const server = await createServer({
    ...renderer,
    configFile: false,
    logLevel: "silent",
    server: { ...renderer.server, port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string")
      throw Error("No loopback server");
    const html = await (
      await fetch(`http://127.0.0.1:${address.port}/`)
    ).text();
    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("@vite/client");
    await build({
      ...renderer,
      configFile: false,
      logLevel: "silent",
      build: { ...renderer.build, outDir: root },
    });
    const packaged = await readFile(join(root, "index.html"), "utf8");
    expect(packaged).toContain('http-equiv="Content-Security-Policy"');
    expect(packaged).toContain("connect-src 'none'");
    expect(packaged).not.toContain("unsafe-inline");
    expect(packaged).not.toContain("@vite/client");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
