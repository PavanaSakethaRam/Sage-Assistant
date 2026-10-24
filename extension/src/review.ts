/** Native literal diff review owns the sole local file gesture and opaque approval. */
import * as vscode from "vscode";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  FOCUS_NAMES,
  parseCodeGrant,
  proposalHash,
  type CodeContext,
  type CodeProposal,
  type CodeGrant,
} from "../../desktop/shared/coding-contracts";
import {
  sameBinding,
  type BridgeData,
} from "../../desktop/shared/editor-bridge";
import {
  contextOffer,
  validateContext,
  releaseContext,
  ownProposal,
  onContextRelease,
} from "./context";
import type { ExtensionBridge } from "./bridge";
import type { EffectJournal } from "./journal";
import { createFocusProject } from "./create";
import { replaceFocusFile } from "./replace";
declare const localReview: unique symbol;
export type LocalReview = { readonly [localReview]: never };
type Authority = {
  context: CodeContext;
  proposal: CodeProposal;
  grant: CodeGrant;
  bridge: ExtensionBridge;
  journal: EffectJournal;
  check: () => void;
};
const approvals = new WeakMap<LocalReview, Authority>();
export function consumeLocalReview(
  token: LocalReview,
  context: CodeContext,
  proposal: CodeProposal,
): Authority {
  const owned = approvals.get(token);
  approvals.delete(token);
  if (!owned || owned.context !== context || owned.proposal !== proposal)
    throw Error("Local file confirmation required");
  owned.check();
  return owned;
}
// The late native notification retains only this settled choice, never proposal/context.
function abortableChoice<T>(
  choice: Thenable<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", stop);
      reject(Error("Review cancelled"));
    };
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void choice.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      () => stop(),
    );
  });
}
type Options = {
  bridge: ExtensionBridge;
  journal: EffectJournal;
  guard: () => void;
  onFailure: () => Promise<void>;
  onApplied?: () => void;
};
export class ProposalReview {
  private active = false;
  private source: { clear: () => void } | undefined;
  private reviewedContext: CodeContext | undefined;
  private unsubscribeContext: (() => void) | undefined;
  private generation = 0;
  private controller: AbortController | undefined;
  private pending:
    | {
        hash: string;
        context: CodeContext;
        resolve: (g: CodeGrant) => void;
        reject: (e: Error) => void;
      }
    | undefined;
  private picker: vscode.QuickPick<vscode.QuickPickItem> | undefined;
  private texts = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  private provider: vscode.Disposable;
  private unsubscribe: () => void;
  constructor(private readonly options: Options) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(
      "sage-diff",
      {
        onDidChange: this.emitter.event,
        provideTextDocumentContent: (uri) =>
          this.texts.get(uri.toString()) ?? "Review expired or cancelled.",
      },
    );
    this.unsubscribe = options.bridge.onData((message) =>
      this.receive(message),
    );
  }
  private receive(message: BridgeData): void {
    if (message.kind !== "grant.reply") return;
    const p = this.pending;
    this.pending = undefined;
    try {
      if (
        !p ||
        this.controller?.signal.aborted ||
        message.payload.kind !== "grant"
      )
        throw Error("Unexpected file grant");
      const grant = parseCodeGrant(message.payload.grant);
      this.options.guard();
      contextOffer(p.context);
      if (
        !sameBinding(grant.binding, p.context.binding) ||
        !sameBinding(message.binding, p.context.binding) ||
        grant.scope !==
          (p.context.mode === "create_focus_project"
            ? "code.create"
            : "code.replace") ||
        grant.approved_hash !== p.hash ||
        grant.consumed_at ||
        Date.parse(grant.issued_at) > Date.now() ||
        Date.parse(grant.expires_at) <= Date.now()
      )
        throw Error("Uncorrelated file grant");
      p.resolve(
        Object.freeze({
          ...grant,
          binding: Object.freeze({ ...grant.binding }),
        }),
      );
    } catch (error) {
      p?.reject(error as Error);
      void this.options.onFailure();
    }
  }
  private choose(
    items: vscode.QuickPickItem[],
    check: () => void,
  ): Promise<string | undefined> {
    check();
    return new Promise((resolve, reject) => {
      const picker = vscode.window.createQuickPick();
      this.picker = picker;
      picker.title = "Sage: Review focus project";
      picker.placeholder = picker.title;
      picker.ignoreFocusOut = true;
      picker.items = items;
      let done = false;
      const finish = (value?: string) => {
        if (done) return;
        done = true;
        accept.dispose();
        hide.dispose();
        picker.dispose();
        if (this.picker === picker) this.picker = undefined;
        try {
          check();
          resolve(value);
        } catch (error) {
          reject(error);
        }
      };
      const accept = picker.onDidAccept(() =>
          finish(picker.selectedItems[0]?.label),
        ),
        hide = picker.onDidHide(() => finish());
      picker.show();
    });
  }
  show(context: CodeContext, input: CodeProposal): Promise<void> {
    try {
      if (this.active) throw Error("Review already active");
      const owned = ownProposal(context, input);
      this.source = owned;
      this.reviewedContext = context;
      this.unsubscribeContext = onContextRelease(
        context,
        this.cancel.bind(this),
      );
      return this.showOwned(context, owned.proposal);
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private async showOwned(
    context: CodeContext,
    proposal: CodeProposal,
  ): Promise<void> {
    if (this.active) throw Error("Review already active");
    this.active = true;
    const generation = ++this.generation,
      controller = new AbortController();
    this.controller = controller;
    const started = Date.now(),
      mono = performance.now();
    let last = started,
      applied = false;
    const check = () => {
      this.options.guard();
      contextOffer(context);
      const now = Date.now();
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        now < last ||
        now - started >= 300000 ||
        performance.now() - mono >= 300000
      )
        throw Error("Review expired or cancelled");
      last = now;
    };
    const timer = setTimeout(() => this.cancel(), 300000);
    try {
      check();
      await validateContext(context);
      check();
      const replacing = context.mode === "replace_focus_file",
        scope = replacing
          ? ("code.replace" as const)
          : ("code.create" as const),
        names = replacing ? [context.target!] : FOCUS_NAMES,
        action = replacing ? "Apply and save this file" : "Create four files";
      const hash = await proposalHash(proposal, context, scope);
      check();
      const opened = new Set<string>(),
        diffId = randomBytes(16).toString("hex");
      while (true) {
        const choice = await this.choose(
          [
            ...names.map((name) => ({
              label: `Review ${name}`,
              description: opened.has(name)
                ? "Opened"
                : replacing
                  ? "Saved UTF-8/LF source → proposed UTF-8/LF text"
                  : "Empty baseline → proposed text",
            })),
            ...(opened.size === names.length ? [{ label: action }] : []),
            { label: "Decline" },
          ],
          check,
        );
        check();
        if (!choice || choice === "Decline") return;
        const name = names.find((n) => choice === `Review ${n}`);
        if (name) {
          const file = proposal.files.find((f) => f.name === name)!,
            id = diffId,
            left = vscode.Uri.parse(`sage-diff:/${id}/empty/${name}`),
            right = vscode.Uri.parse(`sage-diff:/${id}/proposed/${name}`);
          this.texts.set(
            left.toString(),
            replacing ? context.files.find((f) => f.name === name)!.text : "",
          );
          this.texts.set(right.toString(), file.text);
          await vscode.commands.executeCommand(
            "vscode.diff",
            left,
            right,
            `${name} · UTF-8/LF · ${replacing ? "source SHA256 " + context.files.find((f) => f.name === name)!.disk_hash + " · " : ""}SHA256 ${createHash("sha256").update(file.text).digest("hex")}`,
            { preview: false },
          );
          check();
          opened.add(name);
          const next = await abortableChoice(
            vscode.window.showInformationMessage(
              `Inspect ${name} in the read-only diff. Return when ready to continue.`,
              "Continue review",
            ),
            controller.signal,
          );
          check();
          if (next !== "Continue review") return;
          continue;
        }
        if (choice !== action || opened.size !== names.length)
          throw Error("Review every proposed file first");
        await validateContext(context);
        check();
        const confirmation = await abortableChoice(
          vscode.window.showWarningMessage(
            replacing
              ? "Apply and save this file on this local disk?"
              : "Create four files on this local disk?",
            {
              modal: true,
              detail: `Folder: ${context.root_uri}\n${names.join("\n")}\nReview SHA256: ${hash}\n${replacing ? "One editor replacement and one document save. Human changes stop automatic saving; no undo or rollback." : "Exclusive creation only. Partial files are preserved on failure; no rollback."} Tests will not run.`,
            },
            replacing ? "Apply and save this file" : "Create on local disk",
          ),
          controller.signal,
        );
        check();
        if (
          confirmation !==
          (replacing ? "Apply and save this file" : "Create on local disk")
        )
          return;
        await validateContext(context);
        check();
        const grant = await new Promise<CodeGrant>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pending = undefined;
            reject(Error("Review grant timeout"));
            void this.options.onFailure();
          }, 30000);
          this.pending = {
            hash,
            context,
            resolve: (g) => {
              clearTimeout(timeout);
              resolve(g);
            },
            reject: (e) => {
              clearTimeout(timeout);
              reject(e);
            },
          };
          void this.options.bridge
            .send({
              kind: "review.decision",
              binding: context.binding,
              payload: {
                binding: context.binding,
                scope,
                approved_hash: hash,
                decision: "accept",
              },
            })
            .catch((e) => {
              this.pending?.reject(e);
              this.pending = undefined;
            });
        });
        check();
        const grantStart = performance.now(),
          grantRemaining = Date.parse(grant.expires_at) - Date.now();
        const token = Object.freeze({}) as LocalReview;
        approvals.set(token, {
          context,
          proposal,
          grant,
          bridge: this.options.bridge,
          journal: this.options.journal,
          check: () => {
            check();
            if (
              Date.now() >= Date.parse(grant.expires_at) ||
              performance.now() - grantStart >= grantRemaining
            )
              throw Error("Review grant expired");
          },
        });
        if (replacing) {
          const receipt = await replaceFocusFile(context, proposal, token);
          if (receipt.status !== "applied_saved") {
            check();
            const current = vscode.workspace.textDocuments.find(
              (d) =>
                d.uri.scheme === "file" &&
                d.uri.fsPath ===
                  join(fileURLToPath(context.root_uri), context.target!),
            );
            if (
              current &&
              !current.isClosed &&
              [...current.getText()].length <= 32000
            ) {
              const left = vscode.Uri.parse(
                  `sage-diff:/${diffId}/approved/${context.target}`,
                ),
                right = vscode.Uri.parse(
                  `sage-diff:/${diffId}/current/${context.target}`,
                );
              this.texts.set(left.toString(), proposal.files[0].text);
              this.texts.set(right.toString(), current.getText());
              await vscode.commands.executeCommand(
                "vscode.diff",
                left,
                right,
                `${context.target} · approved text → current buffer · disk outcome ${receipt.status}`,
                { preview: false },
              );
              check();
              await abortableChoice(
                vscode.window.showInformationMessage(
                  `File ${receipt.status}. Inspect the current buffer difference; disk observations were recorded. Capture fresh context before another attempt. Tests have not run.`,
                  "Continue review",
                ),
                controller.signal,
              );
              check();
            }
            throw Error("Replacement needs fresh review");
          }
        } else await createFocusProject(context, proposal, token);
        check();
        applied = true;
        this.options.onApplied?.();
        void vscode.window.showInformationMessage(
          replacing
            ? "Focus file saved. Tests have not run."
            : "Focus project files created and saved. Tests have not run.",
        );
        return;
      }
    } finally {
      clearTimeout(timer);
      this.stop(!applied);
      await this.clear();
      this.active = false;
      // Applied context/lease stays owned for the separate, explicit test review.
      if (!applied) await this.options.onFailure();
    }
  }
  cancel(): void {
    this.stop(true);
  }
  private stop(revoke: boolean): void {
    this.source?.clear();
    this.source = undefined;
    this.unsubscribeContext?.();
    this.unsubscribeContext = undefined;
    const context = this.reviewedContext;
    this.reviewedContext = undefined;
    if (revoke && context) releaseContext(context);
    void this.clear();
    this.generation++;
    this.controller?.abort();
    this.pending?.reject(Error("Review cancelled"));
    this.pending = undefined;
    this.picker?.hide();
  }
  private async clear(): Promise<void> {
    const owned = new Set(this.texts.keys());
    this.texts.clear();
    for (const raw of owned) this.emitter.fire(vscode.Uri.parse(raw));
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputTextDiff &&
          (owned.has(t.input.original.toString()) ||
            owned.has(t.input.modified.toString())),
      );
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }
  async dispose(): Promise<void> {
    this.cancel();
    await this.clear();
    this.unsubscribe();
    this.provider.dispose();
    this.emitter.dispose();
  }
}
