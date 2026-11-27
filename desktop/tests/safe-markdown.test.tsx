// @vitest-environment jsdom
import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SafeMarkdown } from "../renderer/SafeMarkdown";
import { fixture } from "./renderer-fixture";
it("suppresses hostile resources and navigation while preserving complete source", async () => {
  const { api, calls } = fixture();
  const text =
    '<script>alert(1)</script>\n<iframe src="https://track.invalid"></iframe>\n<svg><image href="https://track.invalid"/></svg>\n<style>@import "https://track.invalid"</style>\n![tracking](https://track.invalid/pixel)\n[![image](https://track.invalid)](https://example.com)\n[bad](javascript:alert) [local](file:///secret)';
  const { container } = render(<SafeMarkdown text={text} api={api} />);
  expect(
    container.querySelector(
      "img,iframe,svg,style,script,video,audio,source,object,embed,link,form,[href],[src],[srcset]",
    ),
  ).toBeNull();
  await userEvent.click(screen.getByText("Literal Markdown source"));
  expect(screen.getByLabelText("Markdown source").textContent).toBe(text);
  expect(calls).toHaveLength(0);
});
it("opens only explicit allowed activation through host once and reports unavailable", async () => {
  const { api, calls } = fixture({
    "external.open": () => ({ status: "unavailable" }),
  });
  render(<SafeMarkdown api={api} text="[Docs](https://example.com/docs)" />);
  expect(calls).toHaveLength(0);
  const link = screen.getByRole("button", { name: "Open external link: Docs" });
  link.focus();
  await userEvent.keyboard("{Enter}");
  await screen.findByText("External link unavailable");
  expect(calls.map((c) => [c.method, c.params])).toEqual([
    ["external.open", { url: "https://example.com/docs" }],
  ]);
});
it.each([
  "file:///tmp/a",
  "javascript:alert",
  "data:text/plain,a",
  "//example.com",
  "/relative",
  "mailto:a@b.com",
  "https://user:pass@example.com",
  "https://example.com/%0a",
  "https://example.com/" + "x".repeat(2048),
])("keeps forbidden URL inert: %s", (url) => {
  const { api, calls } = fixture();
  const { container } = render(
    <SafeMarkdown api={api} text={`[bad](${url})`} />,
  );
  expect(screen.queryByRole("button", { name: /Open external/ })).toBeNull();
  expect(container.querySelector("[href],[src]")).toBeNull();
  expect(calls).toHaveLength(0);
});
it("preserves formatted link names for keyboard activation and opens HTTP only through the host", async () => {
  const { api, calls } = fixture();
  render(
    <SafeMarkdown
      api={api}
      text="[**Formatted** docs](HTTP://example.com/page)"
    />,
  );
  const link = screen.getByRole("button", {
    name: "Open external link: Formatted docs",
  });
  link.focus();
  await userEvent.keyboard(" ");
  await screen.findByText("External link opened");
  expect(calls.map((c) => c.params)).toEqual([
    { url: "http://example.com/page" },
  ]);
});
it.each([
  "![reference][track]\n\n[track]: https://track.invalid/pixel",
  '<video poster="https://track.invalid/pixel"><source src="https://track.invalid/video"></video>',
  '<audio src="https://track.invalid/a"></audio><object data="https://track.invalid/o"></object><embed src="https://track.invalid/e">',
  '<form action="https://track.invalid"><input></form>',
])("drops media/form syntax structurally without host work: %s", (text) => {
  const { api, calls } = fixture();
  const { container } = render(<SafeMarkdown api={api} text={text} />);
  expect(
    container.querySelector(
      "img,iframe,svg,style,script,video,audio,source,object,embed,link,form,input,[href],[src],[srcset],[poster],[data],[action]",
    ),
  ).toBeNull();
  expect(screen.getByLabelText("Markdown source").textContent).toBe(text);
  expect(calls).toHaveLength(0);
});
