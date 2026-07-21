import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import {
  DEFAULT_API_BASE_URL,
  type Channel,
  type Member,
  type Message,
  type Organization,
  type ServerWebSocketEvent,
  type User
} from "@ziloteams/contracts";
import { ApiClient, ApiClientError } from "./api.js";
import { type ClientConfig, ConfigStore } from "./config.js";
import { RealtimeClient } from "./realtime.js";
import { DialogCancelledError, WorkspaceUi, type UiAction } from "./ui.js";

type OnboardingIntent = "Create organization" | "Join organization";

export class ZiloTeamsApp {
  private readonly configStore = new ConfigStore();
  private readonly ui = new WorkspaceUi();
  private config!: ClientConfig;
  private api!: ApiClient;
  private user!: User;
  private organization!: Organization;
  private channel!: Channel;
  private channels: Channel[] = [];
  private realtime?: RealtimeClient;
  private finished?: () => void;
  private shuttingDown = false;

  async run(): Promise<void> {
    await this.ui.start();
    this.ui.setActionHandler((action) => this.handleAction(action));
    this.config = await this.configStore.load(process.env.ZILOTEAMS_API_URL ?? DEFAULT_API_BASE_URL);
    this.api = new ApiClient(this.config.apiBaseUrl, this.config.sessionToken);

    let intent: OnboardingIntent | undefined;
    if (!this.config.sessionToken || !(await this.restoreSession())) {
      this.ui.setStatus("Sign in to continue");
      intent = await this.ui.choose<OnboardingIntent>("Get started", ["Create organization", "Join organization"]);
      await this.signIn();
    }

    let organizations = await this.api.organizations();
    if (organizations.length === 0) intent ??= await this.ui.choose<OnboardingIntent>("Choose an action", ["Create organization", "Join organization"]);
    if (intent === "Create organization") {
      const created = await this.createOrganization();
      organizations = [created, ...organizations];
    } else if (intent === "Join organization") {
      const joined = await this.joinOrganization();
      if (!organizations.some((item) => item.id === joined.id)) organizations.push(joined);
    }

    const preferred = organizations.find((item) => item.id === this.config.activeOrganizationId);
    this.organization = preferred ?? organizations[0]!;
    await this.openOrganization(this.organization);

    await new Promise<void>((resolve) => { this.finished = resolve; });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.realtime?.disconnect();
    this.ui.stop();
    this.finished?.();
  }

  private async restoreSession(): Promise<boolean> {
    try {
      this.user = await this.api.me();
      return true;
    } catch (error) {
      if (!(error instanceof ApiClientError) || error.status !== 401) throw error;
      await this.configStore.clearSession(this.config);
      this.api.setToken(undefined);
      return false;
    }
  }

  private async signIn(): Promise<void> {
    const email = await this.ui.promptText("Email", { placeholder: "you@example.com" });
    this.ui.setStatus("Sending verification code…");
    await this.api.requestOtp(email);
    this.ui.setStatus("Verification code sent");
    const code = await this.ui.promptText("Verification code", { placeholder: "Six-digit code" });
    const displayName = await this.ui.promptText("Display name", { placeholder: "How teammates will see you" });
    this.ui.setStatus("Verifying account…");
    const result = await this.api.verifyOtp(email, code, displayName);
    this.user = result.user;
    this.config.sessionToken = result.token;
    this.api.setToken(result.token);
    await this.configStore.save(this.config);
  }

  private async createOrganization(): Promise<Organization> {
    const name = await this.ui.promptText("Organization name", { placeholder: "Acme Inc." });
    const created = await this.api.createOrganization(name);
    return created.organization;
  }

  private async joinOrganization(): Promise<Organization> {
    const code = await this.ui.promptText("Invite code", { placeholder: "XXXX-XXXX-XXXX-XXXX" });
    return this.api.redeemInvite(code);
  }

  private async openOrganization(organization: Organization): Promise<void> {
    this.organization = organization;
    this.config.activeOrganizationId = organization.id;
    this.channels = await this.api.channels(organization.id);
    const active = this.channels.filter((item) => !item.archived);
    const preferredId = this.config.activeChannelByOrganization[organization.id];
    const selected = active.find((item) => item.id === preferredId)
      ?? active.find((item) => item.isDefault)
      ?? active[0];
    if (!selected) throw new Error("This organization has no active channels");
    await this.openChannel(selected);
  }

  private async openChannel(channel: Channel): Promise<void> {
    this.realtime?.disconnect();
    this.channel = channel;
    this.config.activeOrganizationId = this.organization.id;
    this.config.activeChannelByOrganization[this.organization.id] = channel.id;
    await this.configStore.save(this.config);
    const messages = await this.api.history(this.organization.id, channel.id);
    this.ui.setWorkspace(this.organization, channel, this.channels);
    this.ui.setMessages(messages);
    this.ui.setPresence([]);
    const token = this.api.getToken();
    if (!token) throw new Error("Sign in to connect");
    const realtime = new RealtimeClient(this.api.websocketUrl(this.organization.id, channel.id), token);
    this.realtime = realtime;
    realtime.on("status", (status: string) => this.ui.setStatus(status));
    realtime.on("event", (event: ServerWebSocketEvent) => this.handleRealtimeEvent(event));
    realtime.on("error", (error: Error) => this.ui.setStatus(error.message));
    realtime.on("sessionExpired", () => { void this.expireSession(); });
    realtime.on("accessChanged", (reason: string) => { void this.recoverFromAccessChange(reason); });
    realtime.connect();
  }

  private handleRealtimeEvent(event: ServerWebSocketEvent): void {
    switch (event.type) {
      case "session.ready":
        this.ui.setMessages(event.messages);
        this.ui.setPresence(event.presence);
        break;
      case "message.created": this.ui.addMessage(event.message); break;
      case "message.deleted": this.ui.deleteMessage(event.messageId, event.deletedAt); break;
      case "presence.snapshot": this.ui.setPresence(event.users); break;
      case "channel.closed": this.ui.setStatus(event.reason); break;
      case "error": this.ui.setStatus(event.message); break;
    }
  }

  private async handleAction(action: UiAction): Promise<void> {
    if (action.type === "send") {
      const clientMessageId = this.realtime?.sendMessage(action.text);
      if (clientMessageId) {
        const pending: Message = {
          id: `pending:${clientMessageId}`,
          clientMessageId,
          channelId: this.channel.id,
          senderId: this.user.id,
          senderName: this.user.displayName,
          kind: "text",
          text: action.text,
          attachment: null,
          createdAt: new Date().toISOString(),
          deletedAt: null
        };
        this.ui.addMessage(pending);
      }
      return;
    }
    if (action.type === "channel") {
      const channel = this.channels.find((item) => item.id === action.channelId && !item.archived);
      if (channel) await this.openChannel(channel);
      return;
    }
    if (action.type === "attachment") {
      await this.openAttachment(action.attachmentId);
      return;
    }
    await this.handleCommand(action.name);
  }

  private async handleCommand(name: string): Promise<void> {
    switch (name) {
      case "channels": await this.chooseChannel(); break;
      case "switch": await this.switchOrganization(); break;
      case "upload": await this.uploadFile(); break;
      case "settings": await this.settings(); break;
      case "invite": await this.invite(); break;
      case "delete": await this.deleteMessage(); break;
      case "help": await this.ui.showMessage("Keyboard shortcuts", "/channels  Switch channel\n/switch    Switch, create, or join an organization\n/upload    Upload a file\n/settings  Personal and administration settings\n/invite    Invite a member (admins)\n/delete    Delete one of your recent messages\n\nCtrl+K switches workspace, Ctrl+L opens channels, Ctrl+U uploads, and Shift+Enter adds a line."); break;
      case "quit": await this.shutdown(); break;
    }
  }

  private async chooseChannel(): Promise<void> {
    await this.modal(async () => {
      this.channels = await this.api.channels(this.organization.id);
      const active = this.channels.filter((item) => !item.archived);
      const label = await this.ui.choose("Channel", active.map((item) => `#${item.name}`));
      const channel = active.find((item) => `#${item.name}` === label);
      if (channel) await this.openChannel(channel);
    });
  }

  private async switchOrganization(): Promise<void> {
    await this.modal(async () => {
      const organizations = await this.api.organizations();
      const labels = [...organizations.map((item) => item.name), "+ Create organization", "+ Join with invite code"];
      const selected = await this.ui.choose("Organization", labels);
      if (selected === "+ Create organization") await this.openOrganization(await this.createOrganization());
      else if (selected === "+ Join with invite code") await this.openOrganization(await this.joinOrganization());
      else {
        const organization = organizations.find((item) => item.name === selected);
        if (organization) await this.openOrganization(organization);
      }
    });
  }

  private async uploadFile(): Promise<void> {
    await this.modal(async () => {
      const filePath = await this.ui.promptText("File path", { placeholder: "~/Downloads/file.pdf" });
      if (!existsSync(filePath)) throw new Error("File not found");
      let lastPercent = -1;
      await this.api.upload(this.organization.id, this.channel.id, filePath, (sent, total) => {
        const percent = Math.floor(sent / total * 100);
        if (percent !== lastPercent) {
          this.ui.setProgress(percent);
          lastPercent = percent;
        }
      });
      this.ui.setProgress(undefined);
      this.ui.setStatus("Upload complete");
    });
  }

  private async openAttachment(attachmentId: string): Promise<void> {
    const access = await this.api.attachmentAccess(attachmentId);
    if (access.disposition === "inline") {
      const command = process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(command, [access.url], { detached: true, stdio: "ignore", shell: false });
      child.once("error", (error) => this.ui.setStatus(`Could not open browser: ${error.message}`));
      child.unref();
      this.ui.setStatus("Opened attachment in browser");
      return;
    }

    const response = await fetch(access.url);
    if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
    const configuredDirectory = this.config.downloadDirectory;
    const directory = configuredDirectory === "~"
      ? homedir()
      : configuredDirectory.startsWith("~/")
        ? join(homedir(), configuredDirectory.slice(2))
        : resolve(configuredDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const original = basename(access.filename);
    const extension = extname(original);
    const stem = original.slice(0, original.length - extension.length);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let destination = join(directory, original);
    for (let suffix = 1; ; suffix += 1) {
      try {
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        destination = join(directory, `${stem}-${suffix}${extension}`);
      }
    }
    this.ui.setStatus(`Downloaded ${destination}`);
  }

  private async invite(): Promise<void> {
    if (this.organization.role !== "admin") throw new Error("Administrator access is required");
    await this.modal(async () => {
      const email = await this.ui.promptText("Invite email", { placeholder: "teammate@example.com" });
      const invite = await this.api.createInvite(this.organization.id, email);
      await this.ui.showMessage("Invite created", `Invite code for ${invite.email}:\n\n${invite.code}\n\nExpires ${new Date(invite.expiresAt).toLocaleString()}. The code is shown only once.`);
    });
  }

  private async deleteMessage(): Promise<void> {
    await this.modal(async () => {
      const eligible = this.ui.getMessages().filter((message) => !message.deletedAt && (message.senderId === this.user.id || this.organization.role === "admin")).slice(-20);
      if (eligible.length === 0) throw new Error("There are no messages you can delete");
      const labels = eligible.map((message) => `${message.id.slice(0, 8)} · ${message.senderName}: ${message.attachment?.filename ?? message.text ?? "attachment"}`);
      const selected = await this.ui.choose("Delete message", labels);
      const message = eligible[labels.indexOf(selected)];
      if (message && await this.ui.confirm("Delete this message permanently?")) {
        await this.api.deleteMessage(this.organization.id, this.channel.id, message.id);
      }
    });
  }

  private async settings(): Promise<void> {
    await this.modal(async () => {
      const options = ["Change display name", "Change download directory"];
      if (this.organization.role === "admin") options.push("Rename organization", "Manage members", "Manage invites", "Manage channels");
      options.push("Sign out", "Back");
      const selected = await this.ui.choose("Settings", options);
      if (selected === "Change display name") {
        const name = await this.ui.promptText("Display name", { initialValue: this.user.displayName });
        this.user = await this.api.updateMe(name);
      } else if (selected === "Change download directory") {
        this.config.downloadDirectory = await this.ui.promptText("Download directory", { initialValue: this.config.downloadDirectory });
        await this.configStore.save(this.config);
      } else if (selected === "Rename organization") {
        const name = await this.ui.promptText("Organization name", { initialValue: this.organization.name });
        await this.api.renameOrganization(this.organization.id, name);
        this.organization = { ...this.organization, name };
      } else if (selected === "Manage members") await this.manageMembers();
      else if (selected === "Manage invites") await this.manageInvites();
      else if (selected === "Manage channels") await this.manageChannels();
      else if (selected === "Sign out" && await this.ui.confirm("Sign out of ZiloTeams?")) {
        await this.api.logout();
        await this.configStore.clearSession(this.config);
        await this.shutdown();
      }
    });
  }

  private async manageMembers(): Promise<void> {
    const members = await this.api.members(this.organization.id);
    const labels = members.map((member) => `${member.displayName} <${member.email}> [${member.role}]`);
    const selected = await this.ui.choose("Member", [...labels, "Back"]);
    if (selected === "Back") return;
    const member = members[labels.indexOf(selected)];
    if (!member) return;
    const action = await this.ui.choose("Action", [member.role === "admin" ? "Make member" : "Make admin", "Remove", "Back"]);
    if (action === "Make member") await this.api.updateMember(this.organization.id, member.userId, "member");
    else if (action === "Make admin") await this.api.updateMember(this.organization.id, member.userId, "admin");
    else if (action === "Remove" && await this.ui.confirm(`Remove ${member.displayName}?`)) await this.api.removeMember(this.organization.id, member.userId);
  }

  private async manageInvites(): Promise<void> {
    const invites = (await this.api.invites(this.organization.id)).filter((invite) => invite.status === "pending");
    if (invites.length === 0) {
      await this.ui.showMessage("Pending invites", "There are no pending invites.");
      return;
    }
    const labels = invites.map((invite) => `${invite.email} · expires ${new Date(invite.expiresAt).toLocaleDateString()}`);
    const selected = await this.ui.choose("Pending invite", [...labels, "Back"]);
    if (selected === "Back") return;
    const invite = invites[labels.indexOf(selected)];
    if (invite && await this.ui.confirm(`Revoke the invite for ${invite.email}?`)) await this.api.revokeInvite(this.organization.id, invite.id);
  }

  private async manageChannels(): Promise<void> {
    this.channels = await this.api.channels(this.organization.id);
    const selected = await this.ui.choose("Channel management", ["Create channel", "Edit channel", "Back"]);
    if (selected === "Create channel") {
      const name = await this.ui.promptText("Channel name");
      const topic = await this.ui.promptText("Topic", { required: false });
      await this.api.createChannel(this.organization.id, name, topic);
    } else if (selected === "Edit channel") {
      const labels = this.channels.map((channel) => `#${channel.name}${channel.archived ? " [archived]" : ""}`);
      const label = await this.ui.choose("Channel", labels);
      const channel = this.channels[labels.indexOf(label)];
      if (!channel) return;
      const actions = ["Rename", channel.archived ? "Restore" : "Archive"];
      if (!channel.isDefault) actions.push("Delete");
      actions.push("Back");
      const action = await this.ui.choose("Action", actions);
      if (action === "Rename") await this.api.updateChannel(this.organization.id, channel.id, { name: await this.ui.promptText("Channel name", { initialValue: channel.name }) });
      else if (action === "Archive") await this.api.updateChannel(this.organization.id, channel.id, { archived: true });
      else if (action === "Restore") await this.api.updateChannel(this.organization.id, channel.id, { archived: false });
      else if (action === "Delete" && await this.ui.confirm(`Permanently delete #${channel.name} and its history?`)) await this.api.deleteChannel(this.organization.id, channel.id);
    }
    this.channels = await this.api.channels(this.organization.id);
  }

  private async modal(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      if (this.finished && !this.shuttingDown) this.ui.setWorkspace(this.organization, this.channel, this.channels);
    } catch (error) {
      if (!(error instanceof DialogCancelledError)) throw error;
    }
  }

  private async expireSession(): Promise<void> {
    this.ui.setStatus("Session expired. Run ziloteams again to sign in.");
    await this.configStore.clearSession(this.config);
    await this.shutdown();
  }

  private async recoverFromAccessChange(reason: string): Promise<void> {
    this.ui.setStatus(reason);
    const organizations = await this.api.organizations();
    const fallback = organizations.find((item) => item.id !== this.organization.id) ?? organizations[0];
    if (fallback) await this.openOrganization(fallback);
    else await this.shutdown();
  }
}
