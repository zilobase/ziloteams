import { MAX_FILE_BYTES, isPlainObject, requiredString, type Attachment } from "@ziloteams/contracts";
import type { AuthContext } from "./auth.js";
import { hmacHex, secureHexEqual } from "./crypto.js";
import { primaryDb, requireMembership } from "./db.js";
import { ApiError, assert } from "./errors.js";
import { json, readJsonObject } from "./http.js";
import { channelForMember } from "./organizations.js";

export interface CleanupJob {
  jobId: string;
  kind: "attachment" | "channel";
  targetId: string;
}

interface AttachmentRow {
  id: string;
  organization_id: string;
  channel_id: string;
  message_id: string | null;
  uploader_id: string;
  object_key: string;
  filename: string;
  media_type: string;
  size: number;
  status: "pending" | "uploading" | "ready" | "deleting" | "deleted";
  created_at: number;
}

const INLINE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
  "video/mp4", "video/webm", "video/ogg"
]);

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  txt: "text/plain", pdf: "application/pdf", zip: "application/zip", json: "application/json",
  csv: "text/csv", md: "text/markdown"
};

function sanitizeFilename(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  const sanitized = leaf.replace(/[\u0000-\u001f\u007f";]/g, "_").trim();
  return (sanitized || "attachment").slice(0, 180);
}

function inferMediaType(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPES[extension] ?? "application/octet-stream";
}

function mapAttachment(row: AttachmentRow): Attachment {
  if (row.status === "uploading") throw new Error("An uploading attachment cannot be serialized");
  return {
    id: row.id,
    organizationId: row.organization_id,
    channelId: row.channel_id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function initiateAttachment(
  request: Request,
  organizationId: string,
  channelId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await channelForMember(env, organizationId, channelId, auth.user.id);
  const body = await readJsonObject(request);
  const filename = sanitizeFilename(requiredString(body, "filename", { min: 1, max: 255 }));
  const size = body.size;
  assert(typeof size === "number" && Number.isSafeInteger(size) && size > 0 && size <= MAX_FILE_BYTES, 400, "invalid_file_size", `Files must be between 1 byte and ${MAX_FILE_BYTES} bytes`);

  const recent = await primaryDb(env).prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE uploader_id = ? AND created_at >= ?"
  ).bind(auth.user.id, Date.now() - 60 * 60_000).first<{ count: number }>();
  assert((recent?.count ?? 0) < 20, 429, "upload_rate_limited", "Too many uploads; try again later");

  const id = crypto.randomUUID();
  const mediaType = inferMediaType(filename);
  const objectKey = `${organizationId}/${channelId}/${id}`;
  const createdAt = Date.now();
  await primaryDb(env).prepare(
    `INSERT INTO attachments
     (id, organization_id, channel_id, uploader_id, object_key, filename, media_type, size, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(id, organizationId, channelId, auth.user.id, objectKey, filename, mediaType, size, createdAt).run();

  return json({
    attachment: mapAttachment({
      id, organization_id: organizationId, channel_id: channelId, message_id: null,
      uploader_id: auth.user.id, object_key: objectKey, filename, media_type: mediaType,
      size, status: "pending", created_at: createdAt
    }),
    uploadPath: `/attachments/${id}/content`
  }, 201);
}

export async function uploadAttachment(
  request: Request,
  attachmentId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  const row = await primaryDb(env).prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(attachmentId).first<AttachmentRow>();
  assert(row && row.status === "pending", 404, "upload_not_found", "Pending upload not found");
  assert(row.uploader_id === auth.user.id, 403, "upload_forbidden", "This upload belongs to another user");
  await requireMembership(env, row.organization_id, auth.user.id);
  const contentLength = Number(request.headers.get("content-length"));
  assert(Number.isSafeInteger(contentLength) && contentLength === row.size && contentLength <= MAX_FILE_BYTES, 400, "content_length_mismatch", "Content-Length must match the declared file size");
  assert(request.body, 400, "empty_upload", "The upload body is empty");
  const claim = await primaryDb(env).prepare(
    "UPDATE attachments SET status = 'uploading' WHERE id = ? AND status = 'pending'"
  ).bind(row.id).run();
  assert(claim.meta.changes === 1, 409, "upload_in_progress", "This upload is already in progress");

  try {
    const stored = await env.ATTACHMENTS.put(row.object_key, request.body, {
      httpMetadata: { contentType: row.media_type },
      customMetadata: { attachmentId: row.id, organizationId: row.organization_id, channelId: row.channel_id }
    });
    assert(stored.size === row.size, 400, "content_length_mismatch", "Uploaded bytes did not match the declared file size");
    const attachment = mapAttachment({ ...row, status: "ready" });
    const message = await env.CHANNELS.getByName(row.channel_id)
      .publishAttachment(row.channel_id, auth.user.id, auth.user.display_name, attachment);
    await primaryDb(env).prepare(
      "UPDATE attachments SET status = 'ready', message_id = ? WHERE id = ? AND status = 'uploading'"
    ).bind(message.id, row.id).run();
    return json({ attachment: { ...attachment, status: "ready" }, message });
  } catch (error) {
    await env.ATTACHMENTS.delete(row.object_key);
    await primaryDb(env).prepare("DELETE FROM attachments WHERE id = ? AND status = 'uploading'").bind(row.id).run();
    console.error(JSON.stringify({ message: "attachment_upload_failed", attachmentId, error: error instanceof Error ? error.message : String(error) }));
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "upload_failed", "The file could not be uploaded");
  }
}

export async function createAttachmentAccess(
  attachmentId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  const row = await primaryDb(env).prepare("SELECT * FROM attachments WHERE id = ? AND status = 'ready'")
    .bind(attachmentId).first<AttachmentRow>();
  assert(row, 404, "attachment_not_found", "Attachment not found");
  await requireMembership(env, row.organization_id, auth.user.id);
  const expires = Math.floor(Date.now() / 1000) + 600;
  const signature = await hmacHex(env.FILE_SIGNING_KEY, `${attachmentId}.${expires}`);
  return json({
    url: `${env.PUBLIC_BASE_URL}/files/${encodeURIComponent(attachmentId)}?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000).toISOString(),
    filename: row.filename,
    disposition: INLINE_TYPES.has(row.media_type) ? "inline" : "attachment"
  });
}

function parseRange(value: string | null, size: number): { offset: number; length: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return undefined;
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset < 0 || offset >= size || requestedEnd < offset) return undefined;
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

export async function serveAttachment(request: Request, attachmentId: string, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  assert(Number.isSafeInteger(expires) && expires >= Math.floor(Date.now() / 1000), 403, "file_link_expired", "This attachment link has expired");
  const expected = await hmacHex(env.FILE_SIGNING_KEY, `${attachmentId}.${expires}`);
  assert(await secureHexEqual(signature, expected), 403, "invalid_file_link", "This attachment link is invalid");

  const row = await primaryDb(env).prepare("SELECT * FROM attachments WHERE id = ? AND status = 'ready'")
    .bind(attachmentId).first<AttachmentRow>();
  assert(row, 404, "attachment_not_found", "Attachment not found");
  const range = parseRange(request.headers.get("range"), row.size);
  const object = await env.ATTACHMENTS.get(row.object_key, range ? { range } : undefined);
  assert(object?.body, 404, "attachment_not_found", "Attachment not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; img-src 'self'; media-src 'self'");
  const disposition = INLINE_TYPES.has(row.media_type) ? "inline" : "attachment";
  headers.set("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
    headers.set("content-length", String(range.length));
  } else {
    headers.set("content-length", String(row.size));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function deleteMessage(
  organizationId: string,
  channelId: string,
  messageId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await channelForMember(env, organizationId, channelId, auth.user.id, true);
  const membership = await requireMembership(env, organizationId, auth.user.id);
  try {
    const result = await env.CHANNELS.getByName(channelId)
      .deleteMessage(messageId, auth.user.id, membership.role === "admin");
    if (result.attachmentId) {
      const jobId = `attachment:${result.attachmentId}`;
      const db = primaryDb(env);
      await db.batch([
        db.prepare("UPDATE attachments SET status = 'deleting' WHERE id = ? AND status = 'ready'").bind(result.attachmentId),
        db.prepare(
          `INSERT INTO cleanup_jobs (id, kind, target_id, status, created_at) VALUES (?, 'attachment', ?, 'pending', ?)
           ON CONFLICT(id) DO UPDATE SET status = 'pending', completed_at = NULL`
        ).bind(jobId, result.attachmentId, Date.now())
      ]);
      await env.CLEANUP_QUEUE.send({ jobId, kind: "attachment", targetId: result.attachmentId } satisfies CleanupJob);
    }
    return json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "message_not_found") throw new ApiError(404, "message_not_found", "Message not found");
    if (error instanceof Error && error.message === "message_delete_forbidden") throw new ApiError(403, "message_delete_forbidden", "You cannot delete this message");
    throw error;
  }
}

function isCleanupJob(value: unknown): value is CleanupJob {
  return isPlainObject(value)
    && typeof value.jobId === "string"
    && (value.kind === "attachment" || value.kind === "channel")
    && typeof value.targetId === "string";
}

async function cleanAttachment(env: Env, attachmentId: string): Promise<void> {
  const row = await primaryDb(env).prepare("SELECT object_key FROM attachments WHERE id = ?")
    .bind(attachmentId).first<{ object_key: string }>();
  if (row) await env.ATTACHMENTS.delete(row.object_key);
  await primaryDb(env).prepare("UPDATE attachments SET status = 'deleted', deleted_at = ? WHERE id = ?")
    .bind(Date.now(), attachmentId).run();
}

async function cleanChannel(env: Env, channelId: string): Promise<boolean> {
  const rows = await primaryDb(env).prepare(
    "SELECT id, object_key FROM attachments WHERE channel_id = ? AND status != 'deleted' LIMIT 100"
  ).bind(channelId).all<{ id: string; object_key: string }>();
  if (rows.results.length > 0) {
    await env.ATTACHMENTS.delete(rows.results.map((row) => row.object_key));
    const db = primaryDb(env);
    await db.batch(rows.results.map((row) => db.prepare(
      "UPDATE attachments SET status = 'deleted', deleted_at = ? WHERE id = ?"
    ).bind(Date.now(), row.id)));
  }
  return rows.results.length === 100;
}

export async function processCleanupBatch(batch: MessageBatch, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (!isCleanupJob(message.body)) {
        message.ack();
        continue;
      }
      if (message.body.kind === "attachment") {
        await cleanAttachment(env, message.body.targetId);
      } else if (await cleanChannel(env, message.body.targetId)) {
        message.retry({ delaySeconds: 1 });
        continue;
      }
      await primaryDb(env).prepare("UPDATE cleanup_jobs SET status = 'complete', completed_at = ? WHERE id = ?")
        .bind(Date.now(), message.body.jobId).run();
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({ message: "cleanup_failed", queueMessageId: message.id, error: error instanceof Error ? error.message : String(error) }));
      message.retry({ delaySeconds: Math.min(60 * (message.attempts + 1), 600) });
    }
  }
}

export async function scheduledCleanup(env: Env): Promise<void> {
  const now = Date.now();
  const db = primaryDb(env);
  await db.batch([
    db.prepare("DELETE FROM auth_challenges WHERE expires_at < ?").bind(now - 24 * 60 * 60_000),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM invites WHERE expires_at < ? AND (redeemed_at IS NOT NULL OR revoked_at IS NOT NULL)")
      .bind(now - 30 * 24 * 60 * 60_000)
  ]);

  const stale = await db.prepare(
    "SELECT id FROM attachments WHERE status IN ('pending', 'uploading') AND created_at < ? LIMIT 100"
  ).bind(now - 60 * 60_000).all<{ id: string }>();
  for (const row of stale.results) {
    const jobId = `attachment:${row.id}`;
    await db.prepare(
      `INSERT INTO cleanup_jobs (id, kind, target_id, status, created_at) VALUES (?, 'attachment', ?, 'pending', ?)
       ON CONFLICT(id) DO UPDATE SET status = 'pending', completed_at = NULL`
    ).bind(jobId, row.id, now).run();
    await env.CLEANUP_QUEUE.send({ jobId, kind: "attachment", targetId: row.id } satisfies CleanupJob);
  }

  const pendingJobs = await db.prepare(
    "SELECT id, kind, target_id FROM cleanup_jobs WHERE status = 'pending' AND created_at < ? LIMIT 100"
  ).bind(now - 5 * 60_000).all<{ id: string; kind: "attachment" | "channel"; target_id: string }>();
  for (const job of pendingJobs.results) {
    await env.CLEANUP_QUEUE.send({ jobId: job.id, kind: job.kind, targetId: job.target_id } satisfies CleanupJob);
  }
}
