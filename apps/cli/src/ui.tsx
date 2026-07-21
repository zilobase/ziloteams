import { createCliRenderer, defaultTextareaKeyBindings, type CliRenderer, type PasteEvent, type SelectOption, type TextareaOptions, type TextareaRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useTerminalDimensions, type Root } from "@opentui/react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Channel, Message, Organization, PresenceUser } from "@ziloteams/contracts";
import { availableCommands, colorIndexForUsername, layoutSize, markMessageDeleted, parseFencedCode, upsertMessage } from "./ui-model.js";
import { theme } from "./theme.js";

export type UiAction =
  | { type: "send"; text: string }
  | { type: "command"; name: string }
  | { type: "channel"; channelId: string }
  | { type: "attachment"; attachmentId: string };

type Dialog =
  | { kind: "text"; title: string; label: string; initialValue: string; required: boolean; placeholder?: string }
  | { kind: "select"; title: string; options: readonly string[]; selectedIndex: number }
  | { kind: "confirm"; title: string }
  | { kind: "message"; title: string; body: string };

interface UiSnapshot {
  mode: "welcome" | "workspace";
  organization?: Organization;
  channel?: Channel;
  channels: Channel[];
  messages: Message[];
  presence: PresenceUser[];
  status: string;
  busy: boolean;
  progress?: number;
  dialog?: Dialog;
}

export class DialogCancelledError extends Error {
  constructor() {
    super("Dialog cancelled");
    this.name = "DialogCancelledError";
  }
}

export class WorkspaceUi {
  private snapshot: UiSnapshot = {
    mode: "welcome",
    channels: [],
    messages: [],
    presence: [],
    status: "Starting ZiloTeams…",
    busy: false
  };
  private readonly listeners = new Set<() => void>();
  private renderer?: CliRenderer;
  private root?: Root;
  private actionHandler?: (action: UiAction) => Promise<void>;
  private dialogResolver?: (value: string | boolean | null) => void;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): UiSnapshot => this.snapshot;

  async start(): Promise<void> {
    if (this.renderer) return;
    this.renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      clearOnShutdown: true,
      screenMode: "alternate-screen",
      useMouse: true,
      autoFocus: true,
      backgroundColor: theme.background,
      openConsoleOnError: false
    });
    this.root = createRoot(this.renderer);
    this.root.render(<ZiloTeamsView store={this} />);
  }

  stop(): void {
    this.dialogResolver?.(null);
    this.dialogResolver = undefined;
    this.root?.unmount();
    this.root = undefined;
    this.renderer?.destroy();
    this.renderer = undefined;
  }

  setActionHandler(handler: (action: UiAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  setWorkspace(organization: Organization, channel: Channel, channels: Channel[]): void {
    this.update({ organization, channel, channels: channels.filter((item) => !item.archived), mode: "workspace" });
  }

  setMessages(messages: Message[]): void {
    this.update({ messages: messages.slice(-500) });
  }

  addMessage(message: Message): void {
    this.update({ messages: upsertMessage(this.snapshot.messages, message) });
  }

  deleteMessage(messageId: string, deletedAt: string): void {
    this.update({ messages: markMessageDeleted(this.snapshot.messages, messageId, deletedAt) });
  }

  setPresence(presence: PresenceUser[]): void {
    this.update({ presence: [...presence] });
  }

  setStatus(status: string): void {
    this.update({ status });
  }

  setProgress(progress?: number): void {
    this.update({ progress });
  }

  getMessages(): Message[] {
    return [...this.snapshot.messages];
  }

  async promptText(label: string, options: { required?: boolean; initialValue?: string; placeholder?: string } = {}): Promise<string> {
    const value = await this.openDialog({
      kind: "text",
      title: label,
      label,
      initialValue: options.initialValue ?? "",
      required: options.required !== false,
      placeholder: options.placeholder
    });
    if (typeof value !== "string") throw new DialogCancelledError();
    return value;
  }

  async choose<T extends string>(title: string, options: readonly T[], selected?: T): Promise<T> {
    if (options.length === 0) throw new Error("No choices are available");
    const requestedIndex = selected === undefined ? 0 : options.indexOf(selected);
    const value = await this.openDialog({ kind: "select", title, options, selectedIndex: Math.max(0, requestedIndex) });
    if (typeof value !== "string") throw new DialogCancelledError();
    return value as T;
  }

  async confirm(title: string): Promise<boolean> {
    return (await this.openDialog({ kind: "confirm", title })) === true;
  }

  async showMessage(title: string, body: string): Promise<void> {
    await this.openDialog({ kind: "message", title, body });
  }

  resolveDialog(value: string | boolean): void {
    const resolve = this.dialogResolver;
    this.dialogResolver = undefined;
    this.update({ dialog: undefined });
    resolve?.(value);
  }

  cancelDialog(): void {
    const resolve = this.dialogResolver;
    this.dialogResolver = undefined;
    this.update({ dialog: undefined });
    resolve?.(null);
  }

  run(action: UiAction): boolean {
    if (!this.actionHandler || (this.snapshot.busy && !(action.type === "command" && action.name === "quit"))) return false;
    this.update({ busy: true });
    void this.actionHandler(action)
      .catch((error: unknown) => {
        if (!(error instanceof DialogCancelledError)) this.setStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => this.update({ busy: false, progress: undefined }));
    return true;
  }

  private openDialog(dialog: Dialog): Promise<string | boolean | null> {
    if (this.dialogResolver) throw new Error("Another dialog is already open");
    this.update({ dialog });
    return new Promise((resolve) => { this.dialogResolver = resolve; });
  }

  private update(patch: Partial<UiSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

export function ZiloTeamsView({ store }: { store: WorkspaceUi }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { width, height } = useTerminalDimensions();

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      store.run({ type: "command", name: "quit" });
      return;
    }
    if (key.name === "escape" && state.dialog) {
      key.preventDefault();
      store.cancelDialog();
      return;
    }
    if (state.dialog) return;
    if (key.ctrl && key.name === "k") {
      key.preventDefault();
      store.run({ type: "command", name: "switch" });
    } else if (key.ctrl && key.name === "l") {
      key.preventDefault();
      store.run({ type: "command", name: "channels" });
    } else if (key.ctrl && key.name === "u") {
      key.preventDefault();
      store.run({ type: "command", name: "upload" });
    }
  });

  if (width < 52 || height < 16) {
    return (
      <box width="100%" height="100%" alignItems="center" justifyContent="center" backgroundColor={theme.background}>
        <box border borderStyle="rounded" borderColor={theme.warning} padding={2} width={Math.max(40, width - 4)} flexDirection="column" gap={1}>
          <text fg={theme.warning}><strong>Terminal is too small</strong></text>
          <text fg={theme.text}>Resize to at least 52 columns by 16 rows.</text>
          <text fg={theme.muted}>Current size: {width} × {height}</text>
        </box>
      </box>
    );
  }

  return (
    <box width="100%" height="100%" backgroundColor={theme.background} flexDirection="column">
      {state.mode === "workspace" && state.organization && state.channel
        ? <Workspace state={state} store={store} width={width} />
        : <Welcome status={state.status} width={width} />}
      {state.dialog && <DialogView dialog={state.dialog} store={store} width={width} height={height} />}
    </box>
  );
}

function Welcome({ status, width }: { status: string; width: number }) {
  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center">
      <box width={Math.min(58, width - 4)} border borderStyle="rounded" borderColor={theme.accentStrong} backgroundColor={theme.panel} padding={2} flexDirection="column" gap={1}>
        <text fg={theme.accent}><strong>Z I L O T E A M S</strong></text>
        <text fg={theme.text}>Invite-only workspaces from your terminal.</text>
        <text fg={theme.muted}>Create a private organization or join with an email-bound invite.</text>
        <text fg={theme.success}>● {status}</text>
      </box>
    </box>
  );
}

function Workspace({ state, store, width }: { state: UiSnapshot; store: WorkspaceUi; width: number }) {
  const organization = state.organization!;
  const channel = state.channel!;
  const size = layoutSize(width);
  const showSidebar = size !== "compact";
  const showDetails = size === "wide";
  const connectionColor = state.status === "Connected" ? theme.success : state.status.includes("connect") ? theme.warning : theme.muted;

  return (
    <>
      <box height={1} width="100%" backgroundColor={theme.bar} flexDirection="row">
        <box height={1} backgroundColor={theme.accentStrong} paddingX={1}>
          <text fg={theme.onAccent}><strong>ZiloTeams</strong></text>
        </box>
        <box height={1} backgroundColor={theme.barSegment} paddingX={1}>
          <text fg={theme.text}><strong>{organization.name}</strong></text>
        </box>
        <text fg={theme.muted}>  </text>
        <text fg={theme.accent}><strong>#{channel.name}</strong></text>
        {size === "wide" && <text fg={theme.subtle}>  {channel.topic || "No topic"}</text>}
        <box flexGrow={1} />
        {state.progress !== undefined && <text fg={theme.peach}>{state.progress}%  </text>}
        {size !== "compact" && <text fg={theme.teal}>{state.presence.length} active  </text>}
        <box height={1} backgroundColor={theme.barSegment} paddingX={1}>
          <text fg={theme.subtle}>{organization.role}</text>
        </box>
        <box height={1} paddingX={1}>
          <text fg={connectionColor}>● <span fg={theme.text}>{state.busy ? "working" : state.status.toLowerCase()}</span></text>
        </box>
      </box>

      <box flexGrow={1} width="100%" flexDirection="row">
        {showSidebar && <ChannelSidebar state={state} store={store} width={size === "wide" ? 25 : 22} />}
        <box flexGrow={1} flexDirection="column" minWidth={30}>
          <MessageList messages={state.messages} store={store} />
          <Composer key={channel.id} state={state} store={store} />
        </box>
        {showDetails && <PresencePanel state={state} />}
      </box>

      <box height={1} width="100%" backgroundColor={theme.bar} flexDirection="row">
        <box height={1} backgroundColor={theme.accent} paddingX={1}>
          <text fg={theme.onAccent}><strong>/ commands</strong></text>
        </box>
        <text fg={theme.subtle}>  ^K workspace   ^L channels</text>
        {size !== "compact" && <text fg={theme.subtle}>   ^U upload</text>}
        <box flexGrow={1} />
        {size !== "compact" && <text fg={theme.muted}>{state.messages.length} messages  </text>}
        <box height={1} backgroundColor={theme.barSegment} paddingX={1}>
          <text fg={theme.text}>{organization.role}</text>
        </box>
      </box>
    </>
  );
}

function ChannelSidebar({ state, store, width }: { state: UiSnapshot; store: WorkspaceUi; width: number }) {
  return (
    <box width={width} height="100%" border={["right"]} borderColor={theme.border} paddingX={1} paddingTop={1} flexDirection="column">
      <text fg={theme.subtle}><strong>channels</strong></text>
      <box height={1} />
      {state.channels.map((channel) => {
        const selected = channel.id === state.channel?.id;
        return (
          <box
            key={channel.id}
            height={1}
            width="100%"
            onMouseDown={() => store.run({ type: "channel", channelId: channel.id })}
          >
            <text fg={selected ? theme.accent : theme.subtle}>{selected ? "›" : " "} #{channel.name}</text>
          </box>
        );
      })}
    </box>
  );
}

function MessageList({ messages, store }: { messages: Message[]; store: WorkspaceUi }) {
  return (
    <scrollbox
      flexGrow={1}
      width="100%"
      stickyScroll
      scrollY
      paddingX={2}
      contentOptions={{ flexDirection: "column", paddingTop: 1 }}
    >
      {messages.length === 0 && (
        <box flexDirection="column" padding={2} gap={1}>
          <text fg={theme.accent}><strong>This channel is ready</strong></text>
          <text fg={theme.muted}>Send the first message to start the conversation.</text>
        </box>
      )}
      {messages.map((message, index) => (
        <MessageItem
          key={message.id}
          message={message}
          store={store}
          separated={index > 0 && messages[index - 1]?.senderId !== message.senderId}
        />
      ))}
    </scrollbox>
  );
}

function MessageItem({ message, store, separated }: { message: Message; store: WorkspaceUi; separated: boolean }) {
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const pending = message.id.startsWith("pending:");
  const code = message.text ? parseFencedCode(message.text) : null;
  if (code && !message.deletedAt) {
    return (
      <box width="100%" marginTop={separated ? 1 : 0} flexDirection="column">
        <box height={1} flexDirection="row">
          <text fg={theme.muted}>{time} </text>
          <text fg={senderColor(message.senderName)}><strong>{message.senderName}</strong></text>
          <text fg={theme.muted}>: code{code.language ? ` · ${code.language}` : ""}</text>
        </box>
        <box marginLeft={6} border={["left"]} borderColor={theme.accentStrong} paddingLeft={1}>
          <text fg={theme.subtle} wrapMode="none" selectable>{code.code}</text>
        </box>
      </box>
    );
  }
  return (
    <box width="100%" minHeight={1} marginTop={separated ? 1 : 0} flexDirection="row">
      <text fg={theme.muted}>{time} </text>
      <text fg={senderColor(message.senderName)}><strong>{message.senderName}</strong></text>
      <text fg={theme.muted}>: </text>
      {message.deletedAt
        ? <text fg={theme.muted}><em>Message deleted</em></text>
        : message.attachment
          ? (
            <box
              onMouseDown={() => store.run({ type: "attachment", attachmentId: message.attachment!.id })}
            >
              <text fg={theme.accent}>↗ {message.attachment.filename} <span fg={theme.muted}>({Math.ceil(message.attachment.size / 1024)} KiB)</span></text>
            </box>
          )
          : <text fg={pending ? theme.muted : theme.text} wrapMode="word">{message.text ?? ""}{pending ? " · sending" : ""}</text>}
    </box>
  );
}

const senderColors = [
  theme.peach,
  theme.teal,
  theme.pink,
  theme.lavender,
  theme.success,
  theme.accentStrong,
  theme.accent,
  theme.warning,
  theme.danger
] as const;

function senderColor(name: string): string {
  return senderColors[colorIndexForUsername(name, senderColors.length)]!;
}

const composerBindings: NonNullable<TextareaOptions["keyBindings"]> = [
  ...defaultTextareaKeyBindings.filter((binding) => !["return", "kpenter", "linefeed"].includes(binding.name)),
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" }
];

function Composer({ state, store }: { state: UiSnapshot; store: WorkspaceUi }) {
  const editor = useRef<TextareaRenderable>(null);
  const [value, setValue] = useState("");
  const [commandIndex, setCommandIndex] = useState(0);
  const commands = useMemo(
    () => value.startsWith("/") ? availableCommands(state.organization?.role ?? "member", value) : [],
    [state.organization?.role, value]
  );

  const submit = () => {
    const text = editor.current?.plainText.trim() ?? value.trim();
    if (!text) return;
    let accepted = false;
    if (text.startsWith("/")) {
      const exact = commands.find((command) => command.name === text.slice(1).toLowerCase());
      const command = exact ?? commands[commandIndex];
      if (command) accepted = store.run({ type: "command", name: command.name });
    } else {
      accepted = store.run({ type: "send", text });
    }
    if (!accepted) return;
    editor.current?.clear();
    setValue("");
    setCommandIndex(0);
  };

  return (
    <box height={5} width="100%" border={["top"]} borderColor={theme.border} paddingX={2} flexDirection="column">
      {commands.length > 0 && (
        <box
          position="absolute"
          left={1}
          bottom={4}
          width="80%"
          zIndex={30}
          border
          borderStyle="rounded"
          borderColor={theme.accent}
          backgroundColor={theme.panelRaised}
          padding={1}
          flexDirection="column"
        >
          {commands.map((command, index) => (
            <text key={command.name} fg={index === commandIndex ? theme.accent : theme.text}>
              {index === commandIndex ? "›" : " "} /{command.name}  <span fg={theme.muted}>{command.label}</span>
            </text>
          ))}
        </box>
      )}
      <textarea
        ref={editor}
        focused={!state.dialog}
        height={3}
        width="100%"
        placeholder={`Message #${state.channel?.name ?? "channel"} — type / for commands`}
        placeholderColor={theme.muted}
        backgroundColor={theme.panel}
        focusedBackgroundColor={theme.panelRaised}
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.accent}
        selectionBg={theme.selected}
        wrapMode="word"
        keyBindings={composerBindings}
        onPaste={(event: PasteEvent) => {
          const pasted = new TextDecoder().decode(event.bytes).replace(/\r\n?/g, "\n");
          if (!pasted.includes("\n") || pasted.trimStart().startsWith("```")) return;
          event.preventDefault();
          const code = pasted.endsWith("\n") ? pasted.slice(0, -1) : pasted;
          editor.current?.insertText(`\`\`\`\n${code}\n\`\`\``);
        }}
        onContentChange={() => {
          const next = editor.current?.plainText ?? "";
          setValue(next.slice(0, 4_000));
          setCommandIndex(0);
        }}
        onKeyDown={(key) => {
          if (commands.length === 0) return;
          if (key.name === "up") {
            key.preventDefault();
            setCommandIndex((index) => Math.max(0, index - 1));
          } else if (key.name === "down") {
            key.preventDefault();
            setCommandIndex((index) => Math.min(commands.length - 1, index + 1));
          } else if (key.name === "escape") {
            key.preventDefault();
            editor.current?.clear();
            setValue("");
          }
        }}
        onSubmit={submit}
      />
      <box height={1} flexDirection="row">
        <text fg={theme.muted}>Enter send · Shift+Enter newline</text>
        <box flexGrow={1} />
        <text fg={value.length > 3_800 ? theme.warning : theme.muted}>{value.length}/4000</text>
      </box>
    </box>
  );
}

function PresencePanel({ state }: { state: UiSnapshot }) {
  return (
    <box width={25} height="100%" backgroundColor={theme.panel} border={["left"]} borderColor={theme.border} padding={1} flexDirection="column" gap={1}>
      <text fg={theme.muted}><strong>CHANNEL DETAILS</strong></text>
      <text fg={theme.text} wrapMode="word">{state.channel?.topic || "No topic yet"}</text>
      <box height={1} />
      <text fg={theme.muted}><strong>ACTIVE · {state.presence.length}</strong></text>
      {state.presence.map((user) => <text key={user.userId} fg={theme.text}><span fg={theme.success}>●</span> {user.displayName}</text>)}
      {state.presence.length === 0 && <text fg={theme.muted}>Waiting for presence…</text>}
    </box>
  );
}

function DialogView({ dialog, store, width, height }: { dialog: Dialog; store: WorkspaceUi; width: number; height: number }) {
  const modalWidth = Math.min(66, width - 6);
  const modalHeight = dialog.kind === "message" ? Math.min(18, height - 4) : dialog.kind === "select" ? Math.min(20, Math.max(9, dialog.options.length * 2 + 5)) : 10;
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={90} backgroundColor={theme.overlay} alignItems="center" justifyContent="center">
      <box width={modalWidth} height={modalHeight} border borderStyle="rounded" borderColor={theme.accentStrong} backgroundColor={theme.panelRaised} padding={1} flexDirection="column" gap={1}>
        <text fg={theme.accent}><strong>{dialog.title}</strong></text>
        {dialog.kind === "text" && <TextDialog dialog={dialog} store={store} />}
        {dialog.kind === "select" && <SelectDialog dialog={dialog} store={store} />}
        {dialog.kind === "confirm" && <ConfirmDialog store={store} />}
        {dialog.kind === "message" && <MessageDialog body={dialog.body} store={store} />}
      </box>
    </box>
  );
}

function TextDialog({ dialog, store }: { dialog: Extract<Dialog, { kind: "text" }>; store: WorkspaceUi }) {
  const [value, setValue] = useState(dialog.initialValue);
  const [error, setError] = useState("");
  return (
    <>
      <text fg={theme.muted}>{dialog.label}</text>
      <box border borderColor={error ? theme.danger : theme.borderFocused} paddingX={1} height={3}>
        <input
          value={value}
          focused
          width="100%"
          placeholder={dialog.placeholder ?? "Type a value…"}
          maxLength={4_000}
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.panel}
          textColor={theme.text}
          cursorColor={theme.accent}
          onInput={(next) => {
            setValue(next);
            setError("");
          }}
          onSubmit={(raw) => {
            const value = typeof raw === "string" ? raw.trim() : "";
            if (dialog.required && !value) setError("A value is required");
            else store.resolveDialog(value);
          }}
        />
      </box>
      <text fg={error ? theme.danger : theme.muted}>{error || "Enter confirm · Esc cancel"}</text>
    </>
  );
}

function SelectDialog({ dialog, store }: { dialog: Extract<Dialog, { kind: "select" }>; store: WorkspaceUi }) {
  const options: SelectOption[] = dialog.options.map((option) => ({ name: option, description: "", value: option }));
  return (
    <select
      focused
      flexGrow={1}
      width="100%"
      options={options}
      selectedIndex={dialog.selectedIndex}
      showDescription={false}
      showScrollIndicator
      wrapSelection
      backgroundColor={theme.panelRaised}
      focusedBackgroundColor={theme.panelRaised}
      textColor={theme.text}
      selectedBackgroundColor={theme.selected}
      selectedTextColor={theme.accent}
      onSelect={(_index, option) => {
        if (option) store.resolveDialog(String(option.value));
      }}
    />
  );
}

function ConfirmDialog({ store }: { store: WorkspaceUi }) {
  return (
    <select
      focused
      height={5}
      width="100%"
      options={[
        { name: "No, go back", description: "", value: false },
        { name: "Yes, continue", description: "", value: true }
      ]}
      showDescription={false}
      backgroundColor={theme.panelRaised}
      focusedBackgroundColor={theme.panelRaised}
      selectedBackgroundColor={theme.selected}
      selectedTextColor={theme.accent}
      onSelect={(_index, option) => store.resolveDialog(Boolean(option?.value))}
    />
  );
}

function MessageDialog({ body, store }: { body: string; store: WorkspaceUi }) {
  return (
    <>
      <scrollbox flexGrow={1} width="100%" scrollY paddingX={1}>
        <text fg={theme.text} wrapMode="word" selectable>{body}</text>
      </scrollbox>
      <select
        focused
        height={1}
        width="100%"
        options={[{ name: "Close", description: "", value: "close" }]}
        showDescription={false}
        showSelectionIndicator={false}
        backgroundColor={theme.selected}
        selectedBackgroundColor={theme.selected}
        selectedTextColor={theme.accent}
        onSelect={() => store.resolveDialog("close")}
      />
    </>
  );
}
