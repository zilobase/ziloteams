import { open, stat } from "node:fs/promises";
import {
  MAX_FILE_BYTES,
  type Attachment,
  type Channel,
  type Invite,
  type InviteCreated,
  type Member,
  type Message,
  type MembershipRole,
  type Organization,
  type User
} from "@ziloteams/contracts";

export class ApiClientError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

interface ApiErrorPayload {
  error?: { code?: string; message?: string };
}

interface StreamingRequestInit extends RequestInit {
  duplex: "half";
}

export class ApiClient {
  constructor(public readonly baseUrl: string, private token?: string) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  websocketUrl(organizationId: string, channelId: string): string {
    return `${this.baseUrl.replace(/^http/, "ws")}/organizations/${organizationId}/channels/${channelId}/socket`;
  }

  async requestOtp(email: string): Promise<void> {
    await this.request("/auth/otp/request", { method: "POST", body: JSON.stringify({ email }) }, false);
  }

  async verifyOtp(email: string, code: string, displayName: string): Promise<{ token: string; user: User }> {
    return this.request("/auth/otp/verify", { method: "POST", body: JSON.stringify({ email, code, displayName }) }, false);
  }

  async me(): Promise<User> {
    const result = await this.request<{ user: User }>("/me");
    return result.user;
  }

  async updateMe(displayName: string): Promise<User> {
    const result = await this.request<{ user: User }>("/me", { method: "PATCH", body: JSON.stringify({ displayName }) });
    return result.user;
  }

  async logout(): Promise<void> {
    await this.request("/auth/session", { method: "DELETE" });
  }

  async organizations(): Promise<Organization[]> {
    return (await this.request<{ organizations: Organization[] }>("/organizations")).organizations;
  }

  async createOrganization(name: string): Promise<{ organization: Organization; channel: Channel }> {
    return this.request("/organizations", { method: "POST", body: JSON.stringify({ name }) });
  }

  async renameOrganization(id: string, name: string): Promise<void> {
    await this.request(`/organizations/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
  }

  async redeemInvite(code: string): Promise<Organization> {
    return (await this.request<{ organization: Organization }>("/invites/redeem", { method: "POST", body: JSON.stringify({ code }) })).organization;
  }

  async invites(organizationId: string): Promise<Invite[]> {
    return (await this.request<{ invites: Invite[] }>(`/organizations/${organizationId}/invites`)).invites;
  }

  async createInvite(organizationId: string, email: string): Promise<InviteCreated> {
    return (await this.request<{ invite: InviteCreated }>(`/organizations/${organizationId}/invites`, {
      method: "POST", body: JSON.stringify({ email })
    })).invite;
  }

  async revokeInvite(organizationId: string, inviteId: string): Promise<void> {
    await this.request(`/organizations/${organizationId}/invites/${inviteId}`, { method: "DELETE" });
  }

  async members(organizationId: string): Promise<Member[]> {
    return (await this.request<{ members: Member[] }>(`/organizations/${organizationId}/members`)).members;
  }

  async updateMember(organizationId: string, userId: string, role: MembershipRole): Promise<void> {
    await this.request(`/organizations/${organizationId}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    await this.request(`/organizations/${organizationId}/members/${userId}`, { method: "DELETE" });
  }

  async channels(organizationId: string): Promise<Channel[]> {
    return (await this.request<{ channels: Channel[] }>(`/organizations/${organizationId}/channels`)).channels;
  }

  async createChannel(organizationId: string, name: string, topic: string): Promise<Channel> {
    return (await this.request<{ channel: Channel }>(`/organizations/${organizationId}/channels`, {
      method: "POST", body: JSON.stringify({ name, topic })
    })).channel;
  }

  async updateChannel(organizationId: string, channelId: string, update: { name?: string; topic?: string; archived?: boolean }): Promise<Channel> {
    return (await this.request<{ channel: Channel }>(`/organizations/${organizationId}/channels/${channelId}`, {
      method: "PATCH", body: JSON.stringify(update)
    })).channel;
  }

  async deleteChannel(organizationId: string, channelId: string): Promise<void> {
    await this.request(`/organizations/${organizationId}/channels/${channelId}`, { method: "DELETE" });
  }

  async history(organizationId: string, channelId: string, before?: string): Promise<Message[]> {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    return (await this.request<{ messages: Message[] }>(`/organizations/${organizationId}/channels/${channelId}/messages${query}`)).messages;
  }

  async deleteMessage(organizationId: string, channelId: string, messageId: string): Promise<void> {
    await this.request(`/organizations/${organizationId}/channels/${channelId}/messages/${messageId}`, { method: "DELETE" });
  }

  async upload(
    organizationId: string,
    channelId: string,
    filePath: string,
    onProgress: (sent: number, total: number) => void
  ): Promise<{ attachment: Attachment; message: Message }> {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_FILE_BYTES) {
      throw new Error(`Choose a regular file no larger than ${MAX_FILE_BYTES} bytes`);
    }
    const filename = filePath.replace(/\\/g, "/").split("/").pop() ?? "attachment";
    const initiated = await this.request<{ attachment: Attachment; uploadPath: string }>(
      `/organizations/${organizationId}/channels/${channelId}/attachments`,
      { method: "POST", body: JSON.stringify({ filename, size: fileStat.size }) }
    );

    const handle = await open(filePath, "r");
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffer = new Uint8Array(Math.min(64 * 1024, fileStat.size - offset));
        if (buffer.length === 0) {
          await handle.close();
          controller.close();
          return;
        }
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) {
          await handle.close();
          controller.close();
          return;
        }
        offset += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
        onProgress(offset, fileStat.size);
      },
      async cancel() { await handle.close(); }
    });
    return this.request(initiated.uploadPath, {
      method: "PUT",
      headers: { "content-length": String(fileStat.size), "content-type": "application/octet-stream" },
      body: stream,
      duplex: "half"
    } as StreamingRequestInit);
  }

  async attachmentAccess(attachmentId: string): Promise<{ url: string; filename: string; disposition: "inline" | "attachment" }> {
    return this.request(`/attachments/${attachmentId}/access`, { method: "POST" });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof ReadableStream)) headers.set("content-type", "application/json");
    if (authenticated) {
      if (!this.token) throw new ApiClientError(401, "authentication_required", "Sign in to continue");
      headers.set("authorization", `Bearer ${this.token}`);
    }
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      let error: ApiErrorPayload = {};
      try { error = await response.json() as ApiErrorPayload; } catch { /* non-JSON failure */ }
      throw new ApiClientError(response.status, error.error?.code ?? "request_failed", error.error?.message ?? `Request failed with status ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
