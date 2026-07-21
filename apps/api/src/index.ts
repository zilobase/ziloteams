import { HISTORY_PAGE_SIZE } from "@ziloteams/contracts";
import { authenticate, getMe, logout, requestOtp, updateMe, verifyOtp } from "./auth.js";
import {
  createAttachmentAccess,
  deleteMessage,
  initiateAttachment,
  processCleanupBatch,
  scheduledCleanup,
  serveAttachment,
  uploadAttachment
} from "./attachments.js";
import { ChannelRoom } from "./ChannelRoom.js";
import { errorResponse, ApiError } from "./errors.js";
import { pathSegments, setRequestIdHeader } from "./http.js";
import {
  channelForMember,
  createChannel,
  createInvite,
  createOrganization,
  deleteChannel,
  listChannels,
  listInvites,
  listMembers,
  listOrganizations,
  redeemInvite,
  removeMember,
  revokeInvite,
  updateChannel,
  updateMember,
  updateOrganization
} from "./organizations.js";
import { serveRelease } from "./releases.js";

export { ChannelRoom };

async function routeApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const segments = pathSegments(url.pathname.slice("/api/v1".length));
  const method = request.method.toUpperCase();

  if (method === "POST" && segments.join("/") === "auth/otp/request") return requestOtp(request, env);
  if (method === "POST" && segments.join("/") === "auth/otp/verify") return verifyOtp(request, env);

  const auth = await authenticate(request, env);
  if (segments.length === 1 && segments[0] === "me") {
    if (method === "GET") return getMe(auth);
    if (method === "PATCH") return updateMe(request, auth, env);
  }
  if (method === "DELETE" && segments.join("/") === "auth/session") return logout(auth, env);
  if (method === "POST" && segments.join("/") === "invites/redeem") return redeemInvite(request, auth, env);

  if (segments.length === 1 && segments[0] === "organizations") {
    if (method === "GET") return listOrganizations(auth, env);
    if (method === "POST") return createOrganization(request, auth, env);
  }

  if (segments[0] === "organizations" && segments[1]) {
    const organizationId = segments[1];
    if (segments.length === 2 && method === "PATCH") return updateOrganization(request, organizationId, auth, env);

    if (segments[2] === "members") {
      if (segments.length === 3 && method === "GET") return listMembers(organizationId, auth, env);
      if (segments[3] && method === "PATCH") return updateMember(request, organizationId, segments[3], auth, env);
      if (segments[3] && method === "DELETE") return removeMember(organizationId, segments[3], auth, env);
    }

    if (segments[2] === "invites") {
      if (segments.length === 3 && method === "GET") return listInvites(organizationId, auth, env);
      if (segments.length === 3 && method === "POST") return createInvite(request, organizationId, auth, env);
      if (segments[3] && method === "DELETE") return revokeInvite(organizationId, segments[3], auth, env);
    }

    if (segments[2] === "channels") {
      if (segments.length === 3 && method === "GET") return listChannels(organizationId, auth, env);
      if (segments.length === 3 && method === "POST") return createChannel(request, organizationId, auth, env);
      const channelId = segments[3];
      if (channelId) {
        if (segments.length === 4 && method === "PATCH") return updateChannel(request, organizationId, channelId, auth, env);
        if (segments.length === 4 && method === "DELETE") return deleteChannel(organizationId, channelId, auth, env);
        if (segments[4] === "messages") {
          if (segments.length === 5 && method === "GET") {
            await channelForMember(env, organizationId, channelId, auth.user.id, true);
            const before = url.searchParams.get("before");
            const beforeValue = before ? Date.parse(before) : undefined;
            if (before && !Number.isFinite(beforeValue)) throw new ApiError(400, "invalid_cursor", "Invalid history cursor");
            const messages = await env.CHANNELS.getByName(channelId).history(beforeValue, HISTORY_PAGE_SIZE);
            return Response.json({ messages, nextCursor: messages[0]?.createdAt ?? null });
          }
          if (segments[5] && method === "DELETE") {
            return deleteMessage(organizationId, channelId, segments[5], auth, env);
          }
        }
        if (segments[4] === "attachments" && segments.length === 5 && method === "POST") {
          return initiateAttachment(request, organizationId, channelId, auth, env);
        }
        if (segments[4] === "socket" && method === "GET") {
          await channelForMember(env, organizationId, channelId, auth.user.id);
          const headers = new Headers(request.headers);
          headers.set("x-ziloteams-user-id", auth.user.id);
          headers.set("x-ziloteams-display-name", auth.user.display_name);
          headers.set("x-ziloteams-session-expires", String(auth.user.session_expires_at));
          headers.set("x-ziloteams-channel-id", channelId);
          return env.CHANNELS.getByName(channelId).fetch(new Request(request.url, { method: "GET", headers }));
        }
      }
    }
  }

  if (segments[0] === "attachments" && segments[1]) {
    if (segments[2] === "content" && method === "PUT") return uploadAttachment(request, segments[1], auth, env);
    if (segments[2] === "access" && method === "POST") return createAttachmentAccess(segments[1], auth, env);
  }

  throw new ApiError(404, "route_not_found", "Route not found");
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    let response: Response;
    if (url.pathname === "/health") {
      response = Response.json({ ok: true, service: "ziloteams", version: "2.0.0" });
    } else if (url.pathname.startsWith("/api/v1/")) {
      response = await routeApi(request, env);
    } else if (url.pathname.startsWith("/files/")) {
      const attachmentId = decodeURIComponent(url.pathname.slice("/files/".length));
      response = await serveAttachment(request, attachmentId, env);
    } else if (url.pathname === "/install.sh") {
      response = await serveRelease("install.sh", env);
    } else if (url.pathname.startsWith("/releases/")) {
      response = await serveRelease(url.pathname.slice("/releases/".length), env);
    } else {
      throw new ApiError(404, "route_not_found", "Route not found");
    }
    setRequestIdHeader(response, requestId);
    console.log(JSON.stringify({
      message: "request_complete",
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Date.now() - startedAt
    }));
    return response;
  } catch (error) {
    const response = errorResponse(error, requestId);
    response.headers.set("x-request-id", requestId);
    return response;
  }
}

export default {
  fetch: handleFetch,
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await processCleanupBatch(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledCleanup(env));
  }
} satisfies ExportedHandler<Env>;
