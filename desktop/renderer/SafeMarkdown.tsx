import { useState } from "react";
import Markdown from "react-markdown";
import type { SageApi } from "../shared/contracts";
import { validateExternalUrl } from "../shared/external-url";
import { call } from "./host";
const elements = [
  "p",
  "br",
  "hr",
  "em",
  "strong",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "code",
  "a",
];
function destination(value: string) {
  try {
    return validateExternalUrl(value);
  } catch {
    return undefined;
  }
}
export function SafeMarkdown({
  text,
  api = window.sage,
}: {
  text: string;
  api?: SageApi;
}) {
  const [status, setStatus] = useState("");
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        allowedElements={elements}
        urlTransform={(url, key, node) =>
          key === "href" && node.tagName === "a" ? destination(url) : undefined
        }
        components={{
          a: ({ href, children }) =>
            href ? (
              <button
                type="button"
                className="external-link"
                onClick={() => {
                  void call(api, "external.open", { url: href }).then(
                    (r) =>
                      setStatus(
                        r.status === "opened"
                          ? "External link opened"
                          : "External link unavailable",
                      ),
                    () => setStatus("External link unavailable"),
                  );
                }}
              >
                <span className="visually-hidden">Open external link:</span>{" "}
                {children}
              </button>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {text}
      </Markdown>
      <details>
        <summary>Literal Markdown source</summary>
        <pre aria-label="Markdown source">{text}</pre>
      </details>
      {status && <p role="status">{status}</p>}
    </div>
  );
}
