import {
  Container,
  Input,
  SelectList,
  Text,
  VStack,
  hyperlink,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TuiAltScreen,
} from "@earendil-works/pi-tui";
import type {
  ProviderAuthEvent,
  ProviderAuthPrompt,
} from "../pi/agent-gateway.js";
import { selectListTheme, tone } from "./theme.js";
import { normalizeBrowserUrl } from "./open-browser.js";

class AuthFrame extends Container {
  override render(width: number): string[] {
    const safeWidth = Math.max(2, width);
    const innerWidth = safeWidth - 2;
    const content = super.render(innerWidth).map((line) => {
      const clipped = truncateToWidth(line, innerWidth);
      return `${tone("│", "border")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${tone("│", "border")}`;
    });
    const horizontal = "─".repeat(innerWidth);
    return [
      tone(`╭${horizontal}╮`, "border"),
      ...content,
      tone(`╰${horizontal}╯`, "border"),
    ];
  }
}

function safeAuthText(value: string): string {
  return value
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function authLink(url: string, label = url): string {
  const normalized = normalizeBrowserUrl(url);
  return normalized
    ? hyperlink(safeAuthText(label), normalized)
    : safeAuthText(label);
}

export class MaskedInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue();
    if (!value) return super.render(width);

    // Mask before Input.render performs horizontal scrolling and cursor layout.
    // Keep UTF-16 length equal so the underlying input cursor remains valid.
    this.setValue("•".repeat(value.length));
    try {
      return super.render(width);
    } finally {
      this.setValue(value);
    }
  }
}

export class ProviderAuthDialog {
  private readonly body = new Container();
  private readonly panel = new AuthFrame();
  private readonly overlay: ReturnType<TuiAltScreen["showOverlay"]>;
  private readonly noticeLines: string[] = [];
  private readonly secretValues: string[] = [];
  private readonly attemptedBrowserUrls = new Set<string>();
  private currentInput: Input | undefined;
  private currentList: SelectList | undefined;
  private activePromptContent: VStack | undefined;

  constructor(
    private readonly tui: TuiAltScreen,
    providerName: string,
    private readonly onCancel: () => void,
    private readonly openUrl: (url: string) => Promise<void>,
  ) {
    this.panel.addChild(
      new VStack([
        new Text(
          tone(`Sign in · ${safeAuthText(providerName)}`, "text", true),
          1,
          0,
        ),
        this.body,
        new Text(tone("Esc cancels sign-in", "dim"), 1, 0),
      ]),
    );
    this.overlay = tui.showOverlay(this.panel, {
      anchor: "center",
      width: "72%",
      minWidth: 48,
      maxHeight: "85%",
    });
    this.noticeLines.push("Starting provider authentication…");
    this.renderNotice();
  }

  notify(event: ProviderAuthEvent): void {
    const safe = (value: string): string => this.redact(safeAuthText(value));
    switch (event.type) {
      case "auth_url":
        this.noticeLines.splice(
          0,
          this.noticeLines.length,
          "Open this sign-in link in your browser:",
          authLink(safe(event.url)),
          ...(event.instructions ? [safe(event.instructions)] : []),
        );
        this.openSignInUrl(event.url);
        break;
      case "device_code":
        this.noticeLines.splice(
          0,
          this.noticeLines.length,
          `Open sign-in page: ${authLink(safe(event.verificationUri))} and enter this one-time code:`,
          safe(event.userCode),
          "Waiting for provider confirmation…",
        );
        this.openSignInUrl(event.verificationUri);
        break;
      case "info":
        this.noticeLines.splice(
          0,
          this.noticeLines.length,
          safe(event.message),
          ...(event.links ?? []).map(({ label, url }) =>
            authLink(
              safe(url),
              label ? `${safe(label)}: ${safe(url)}` : safe(url),
            ),
          ),
        );
        break;
      case "progress":
        this.noticeLines.splice(
          0,
          this.noticeLines.length,
          safe(event.message),
        );
        break;
    }
    if (!this.currentInput && !this.currentList) this.renderNotice();
  }

  prompt(prompt: ProviderAuthPrompt): Promise<string> {
    if (prompt.type === "select") return this.select(prompt);
    return this.input(prompt);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.onCancel();
      return;
    }
    if (this.currentList) this.currentList.handleInput(data);
    else if (this.currentInput) this.currentInput.handleInput(data);
    else if (matchesKey(data, "escape")) this.onCancel();
  }

  close(): void {
    this.currentInput?.setValue("");
    this.currentInput = undefined;
    this.currentList = undefined;
    this.activePromptContent = undefined;
    this.secretValues.fill("");
    this.secretValues.length = 0;
    this.noticeLines.fill("");
    this.noticeLines.length = 0;
    this.body.clear();
    this.overlay.hide();
  }

  redact(value: string): string {
    return this.secretValues.reduce(
      (message, secret) =>
        secret ? message.replaceAll(secret, "[redacted]") : message,
      value,
    );
  }

  private renderNotice(): void {
    this.body.clear();
    this.body.addChild(
      new VStack(this.noticeLines.map((line) => new Text(line, 1, 0))),
    );
    this.tui.requestRender();
  }

  private openSignInUrl(value: string): void {
    const url = normalizeBrowserUrl(value);
    if (!url) {
      this.noticeLines.push(
        "Browser not opened: sign-in URL must use HTTP or HTTPS.",
      );
      if (!this.currentInput && !this.currentList) this.renderNotice();
      return;
    }
    if (this.attemptedBrowserUrls.has(url)) return;
    this.attemptedBrowserUrls.add(url);
    void this.openUrl(url).catch(() => {
      const message =
        "Could not open a browser. Use the sign-in link above to continue.";
      this.noticeLines.push(message);
      if (this.activePromptContent) {
        this.activePromptContent.addChild(
          new Text(safeAuthText(message), 1, 0),
        );
        this.tui.requestRender();
      } else if (!this.currentInput && !this.currentList) {
        this.renderNotice();
      }
    });
  }

  private select(prompt: Extract<ProviderAuthPrompt, { type: "select" }>) {
    return new Promise<string>((resolve, reject) => {
      this.body.clear();
      this.body.addChild(new Text(safeAuthText(prompt.message), 1, 0));
      const list = new SelectList(
        prompt.options.map((option) => ({
          value: option.id,
          label: safeAuthText(option.label),
          ...(option.description
            ? { description: safeAuthText(option.description) }
            : {}),
        })),
        8,
        selectListTheme,
      );
      this.currentList = list;
      this.body.addChild(list);
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        prompt.signal?.removeEventListener("abort", onAbort);
        this.currentList = undefined;
        this.renderNotice();
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const onAbort = () => finish(new Error("Login cancelled"));
      if (prompt.signal?.aborted) {
        onAbort();
        return;
      }
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      list.onSelect = (item) => {
        finish(undefined, item.value);
      };
      list.onCancel = () => {
        finish(new Error("Login cancelled"));
      };
      this.tui.setFocus(list);
      this.tui.requestRender();
    });
  }

  private input(prompt: Exclude<ProviderAuthPrompt, { type: "select" }>) {
    return new Promise<string>((resolve, reject) => {
      this.body.clear();
      const promptContent = new VStack([
        ...this.noticeLines.map((line) => new Text(line, 1, 0)),
        new Text(safeAuthText(prompt.message), 1, 0),
      ]);
      this.activePromptContent = promptContent;
      this.body.addChild(promptContent);
      const input = prompt.type === "secret" ? new MaskedInput() : new Input();
      this.currentInput = input;
      this.body.addChild(input);
      this.body.addChild(
        new Text(tone("Enter submits · Esc cancels", "dim"), 1, 0),
      );
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        prompt.signal?.removeEventListener("abort", onAbort);
        input.setValue("");
        this.currentInput = undefined;
        this.activePromptContent = undefined;
        this.renderNotice();
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const onAbort = () => finish(new Error("Login cancelled"));
      if (prompt.signal?.aborted) {
        onAbort();
        return;
      }
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      input.onSubmit = (value) => {
        if (prompt.type === "secret" && value) this.secretValues.push(value);
        finish(undefined, value);
      };
      input.onEscape = () => finish(new Error("Login cancelled"));
      this.tui.setFocus(input);
      this.tui.requestRender();
    });
  }
}
