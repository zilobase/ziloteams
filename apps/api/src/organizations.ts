import {
  isValidEmail,
  normalizeChannelName,
  normalizeEmail,
  optionalString,
  requiredString,
  type Channel,
  type Invite,
  type InviteCreated,
  type Member,
  type MembershipRole,
  type Organization
} from "@ziloteams/contracts";
import type { AuthContext } from "./auth.js";
import { hmacHex, normalizeInviteCode, randomInviteCode } from "./crypto.js";
import { primaryDb, requireAdmin, requireMembership, toIso } from "./db.js";
import { ApiError, assert } from "./errors.js";
import { json, readJsonObject } from "./http.js";

interface OrganizationRow {
  id: string;
  name: string;
  role: MembershipRole;
  created_at: number;
}

interface ChannelRow {
  id: string;
  organization_id: string;
  name: string;
  topic: string;
  archived_at: number | null;
  is_default: number;
  created_at: number;
}

interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  expires_at: number;
  redeemed_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

function mapOrganization(row: OrganizationRow): Organization {
  return { id: row.id, name: row.name, role: row.role, createdAt: new Date(row.created_at).toISOString() };
}

function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    topic: row.topic,
    archived: row.archived_at !== null,
    isDefault: row.is_default === 1,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function inviteStatus(row: InviteRow): Invite["status"] {
  if (row.revoked_at !== null) return "revoked";
  if (row.redeemed_at !== null) return "redeemed";
  if (row.expires_at <= Date.now()) return "expired";
  return "pending";
}

function mapInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    status: inviteStatus(row),
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString()
  };
}

async function audit(
  env: Env,
  organizationId: string | null,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  metadata: Record<string, string> = {}
): Promise<void> {
  await primaryDb(env).prepare(
    `INSERT INTO audit_events (id, organization_id, actor_id, action, target_type, target_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), organizationId, actorId, action, targetType, targetId, JSON.stringify(metadata), Date.now()).run();
}

export async function listOrganizations(auth: AuthContext, env: Env): Promise<Response> {
  const rows = await primaryDb(env).prepare(
    `SELECT organizations.id, organizations.name, organization_members.role, organizations.created_at
     FROM organization_members JOIN organizations ON organizations.id = organization_members.organization_id
     WHERE organization_members.user_id = ? ORDER BY organizations.name COLLATE NOCASE`
  ).bind(auth.user.id).all<OrganizationRow>();
  return json({ organizations: rows.results.map(mapOrganization) });
}

export async function createOrganization(request: Request, auth: AuthContext, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const name = requiredString(body, "name", { min: 2, max: 80 });
  const now = Date.now();
  const organizationId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const db = primaryDb(env);
  await db.batch([
    db.prepare("INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(organizationId, name, auth.user.id, now, now),
    db.prepare("INSERT INTO organization_members (organization_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)")
      .bind(organizationId, auth.user.id, now),
    db.prepare(
      `INSERT INTO channels (id, organization_id, name, topic, is_default, created_by, created_at, updated_at)
       VALUES (?, ?, 'general', 'Company-wide conversation', 1, ?, ?, ?)`
    ).bind(channelId, organizationId, auth.user.id, now, now)
  ]);
  await audit(env, organizationId, auth.user.id, "organization.created", "organization", organizationId);
  return json({
    organization: mapOrganization({ id: organizationId, name, role: "admin", created_at: now }),
    channel: mapChannel({ id: channelId, organization_id: organizationId, name: "general", topic: "Company-wide conversation", archived_at: null, is_default: 1, created_at: now })
  }, 201);
}

export async function updateOrganization(
  request: Request,
  organizationId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const body = await readJsonObject(request);
  const name = requiredString(body, "name", { min: 2, max: 80 });
  const result = await primaryDb(env).prepare("UPDATE organizations SET name = ?, updated_at = ? WHERE id = ?")
    .bind(name, Date.now(), organizationId).run();
  assert(result.meta.changes === 1, 404, "organization_not_found", "Organization not found");
  await audit(env, organizationId, auth.user.id, "organization.renamed", "organization", organizationId);
  return json({ organization: { id: organizationId, name, role: "admin" } });
}

export async function listMembers(organizationId: string, auth: AuthContext, env: Env): Promise<Response> {
  await requireMembership(env, organizationId, auth.user.id);
  const rows = await primaryDb(env).prepare(
    `SELECT users.id AS user_id, users.email, users.display_name, organization_members.role, organization_members.joined_at
     FROM organization_members JOIN users ON users.id = organization_members.user_id
     WHERE organization_members.organization_id = ? ORDER BY users.display_name COLLATE NOCASE`
  ).bind(organizationId).all<{ user_id: string; email: string; display_name: string; role: MembershipRole; joined_at: number }>();
  const members: Member[] = rows.results.map((row) => ({
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    joinedAt: new Date(row.joined_at).toISOString()
  }));
  return json({ members });
}

async function disconnectMember(env: Env, organizationId: string, userId: string): Promise<void> {
  const channels = await primaryDb(env).prepare(
    "SELECT id FROM channels WHERE organization_id = ? AND deleted_at IS NULL"
  ).bind(organizationId).all<{ id: string }>();
  await Promise.all(channels.results.map((channel) => env.CHANNELS.getByName(channel.id).disconnectUser(userId)));
}

export async function updateMember(
  request: Request,
  organizationId: string,
  targetUserId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const body = await readJsonObject(request);
  const role = requiredString(body, "role", { min: 5, max: 6 });
  assert(role === "admin" || role === "member", 400, "invalid_role", "Role must be admin or member");
  const current = await requireMembership(env, organizationId, targetUserId);
  const result = await primaryDb(env).prepare(
    `UPDATE organization_members SET role = ?
     WHERE organization_id = ? AND user_id = ?
       AND (role != 'admin' OR ? != 'member' OR
         (SELECT COUNT(*) FROM organization_members WHERE organization_id = ? AND role = 'admin') > 1)`
  ).bind(role, organizationId, targetUserId, role, organizationId).run();
  assert(result.meta.changes === 1 || current.role === role, 409, "last_admin", "An organization must retain at least one administrator");
  await audit(env, organizationId, auth.user.id, "member.role_changed", "user", targetUserId, { role });
  return json({ userId: targetUserId, role });
}

export async function removeMember(
  organizationId: string,
  targetUserId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const current = await requireMembership(env, organizationId, targetUserId);
  const result = await primaryDb(env).prepare(
    `DELETE FROM organization_members
     WHERE organization_id = ? AND user_id = ?
       AND (role != 'admin' OR
         (SELECT COUNT(*) FROM organization_members WHERE organization_id = ? AND role = 'admin') > 1)`
  ).bind(organizationId, targetUserId, organizationId).run();
  assert(result.meta.changes === 1, 409, "last_admin", "An organization must retain at least one administrator");
  await disconnectMember(env, organizationId, targetUserId);
  await audit(env, organizationId, auth.user.id, "member.removed", "user", targetUserId);
  return new Response(null, { status: 204 });
}

export async function listInvites(organizationId: string, auth: AuthContext, env: Env): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const rows = await primaryDb(env).prepare(
    "SELECT id, organization_id, email, expires_at, redeemed_at, revoked_at, created_at FROM invites WHERE organization_id = ? ORDER BY created_at DESC"
  ).bind(organizationId).all<InviteRow>();
  return json({ invites: rows.results.map(mapInvite) });
}

export async function createInvite(
  request: Request,
  organizationId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const body = await readJsonObject(request);
  const email = normalizeEmail(requiredString(body, "email", { max: 254 }));
  assert(isValidEmail(email), 400, "invalid_email", "Enter a valid email address");
  const existingMember = await primaryDb(env).prepare(
    `SELECT 1 FROM organization_members JOIN users ON users.id = organization_members.user_id
     WHERE organization_members.organization_id = ? AND users.email = ?`
  ).bind(organizationId, email).first();
  assert(!existingMember, 409, "already_a_member", "That account is already a member");

  const code = randomInviteCode();
  const now = Date.now();
  const row: InviteRow = {
    id: crypto.randomUUID(),
    organization_id: organizationId,
    email,
    expires_at: now + 7 * 24 * 60 * 60_000,
    redeemed_at: null,
    revoked_at: null,
    created_at: now
  };
  const digest = await hmacHex(env.INVITE_HMAC_KEY, normalizeInviteCode(code));
  await primaryDb(env).prepare(
    `INSERT INTO invites (id, organization_id, email, code_digest, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(row.id, organizationId, email, digest, auth.user.id, row.expires_at, now).run();
  await audit(env, organizationId, auth.user.id, "invite.created", "invite", row.id);
  const response: InviteCreated = { ...mapInvite(row), code };
  return json({ invite: response }, 201);
}

export async function revokeInvite(
  organizationId: string,
  inviteId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const result = await primaryDb(env).prepare(
    "UPDATE invites SET revoked_at = ? WHERE id = ? AND organization_id = ? AND redeemed_at IS NULL AND revoked_at IS NULL"
  ).bind(Date.now(), inviteId, organizationId).run();
  assert(result.meta.changes === 1, 404, "invite_not_found", "Active invite not found");
  await audit(env, organizationId, auth.user.id, "invite.revoked", "invite", inviteId);
  return new Response(null, { status: 204 });
}

export async function redeemInvite(request: Request, auth: AuthContext, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const code = normalizeInviteCode(requiredString(body, "code", { min: 16, max: 24 }));
  assert(code.length === 16, 400, "invalid_invite", "The invite code is invalid or expired");
  const digest = await hmacHex(env.INVITE_HMAC_KEY, code);
  const now = Date.now();
  const db = primaryDb(env);
  const invite = await db.prepare(
    `SELECT id, organization_id, email, expires_at, redeemed_at, revoked_at, created_at
     FROM invites WHERE code_digest = ?`
  ).bind(digest).first<InviteRow>();
  assert(invite && invite.expires_at > now && invite.redeemed_at === null && invite.revoked_at === null, 400, "invalid_invite", "The invite code is invalid or expired");
  assert(invite.email === auth.user.email, 403, "invite_email_mismatch", "Sign in with the email address this invite was created for");

  const existing = await db.prepare(
    "SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?"
  ).bind(invite.organization_id, auth.user.id).first<{ role: MembershipRole }>();
  const results = await db.batch([
    db.prepare(
      "UPDATE invites SET redeemed_at = ? WHERE id = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?"
    ).bind(now, invite.id, now),
    db.prepare(
      `INSERT INTO organization_members (organization_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)
       ON CONFLICT(organization_id, user_id) DO NOTHING`
    ).bind(invite.organization_id, auth.user.id, now)
  ]);
  assert(results[0]?.meta.changes === 1, 409, "invite_already_used", "The invite was already used");
  const organization = await db.prepare(
    "SELECT id, name, created_at FROM organizations WHERE id = ?"
  ).bind(invite.organization_id).first<{ id: string; name: string; created_at: number }>();
  assert(organization, 404, "organization_not_found", "Organization not found");
  await audit(env, organization.id, auth.user.id, "invite.redeemed", "invite", invite.id);
  return json({ organization: mapOrganization({ ...organization, role: existing?.role ?? "member" }) });
}

export async function listChannels(organizationId: string, auth: AuthContext, env: Env): Promise<Response> {
  await requireMembership(env, organizationId, auth.user.id);
  const rows = await primaryDb(env).prepare(
    `SELECT id, organization_id, name, topic, archived_at, is_default, created_at
     FROM channels WHERE organization_id = ? AND deleted_at IS NULL ORDER BY archived_at IS NOT NULL, is_default DESC, name`
  ).bind(organizationId).all<ChannelRow>();
  return json({ channels: rows.results.map(mapChannel) });
}

export async function createChannel(
  request: Request,
  organizationId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const body = await readJsonObject(request);
  const name = normalizeChannelName(requiredString(body, "name", { min: 1, max: 50 }));
  const topic = optionalString(body, "topic", 250) ?? "";
  assert(name.length > 0, 400, "invalid_channel_name", "Enter a valid channel name");
  const now = Date.now();
  const row: ChannelRow = {
    id: crypto.randomUUID(), organization_id: organizationId, name, topic,
    archived_at: null, is_default: 0, created_at: now
  };
  try {
    await primaryDb(env).prepare(
      `INSERT INTO channels (id, organization_id, name, topic, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(row.id, organizationId, name, topic, auth.user.id, now, now).run();
  } catch {
    throw new ApiError(409, "channel_name_taken", "A channel with that name already exists");
  }
  await audit(env, organizationId, auth.user.id, "channel.created", "channel", row.id);
  return json({ channel: mapChannel(row) }, 201);
}

export async function updateChannel(
  request: Request,
  organizationId: string,
  channelId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const body = await readJsonObject(request);
  const requestedName = optionalString(body, "name", 50);
  const topic = optionalString(body, "topic", 250);
  const archived = typeof body.archived === "boolean" ? body.archived : undefined;
  const current = await primaryDb(env).prepare(
    `SELECT id, organization_id, name, topic, archived_at, is_default, created_at FROM channels
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  ).bind(channelId, organizationId).first<ChannelRow>();
  assert(current, 404, "channel_not_found", "Channel not found");
  const name = requestedName ? normalizeChannelName(requestedName) : current.name;
  assert(name.length > 0, 400, "invalid_channel_name", "Enter a valid channel name");
  assert(!(current.is_default === 1 && archived === true), 409, "default_channel", "The default channel cannot be archived");
  try {
    await primaryDb(env).prepare(
      "UPDATE channels SET name = ?, topic = ?, archived_at = ?, updated_at = ? WHERE id = ? AND organization_id = ?"
    ).bind(name, topic ?? current.topic, archived === undefined ? current.archived_at : archived ? Date.now() : null, Date.now(), channelId, organizationId).run();
  } catch {
    throw new ApiError(409, "channel_name_taken", "A channel with that name already exists");
  }
  await audit(env, organizationId, auth.user.id, "channel.updated", "channel", channelId);
  return json({ channel: mapChannel({ ...current, name, topic: topic ?? current.topic, archived_at: archived === undefined ? current.archived_at : archived ? Date.now() : null }) });
}

export async function deleteChannel(
  organizationId: string,
  channelId: string,
  auth: AuthContext,
  env: Env
): Promise<Response> {
  await requireAdmin(env, organizationId, auth.user.id);
  const channel = await primaryDb(env).prepare(
    "SELECT is_default FROM channels WHERE id = ? AND organization_id = ? AND deleted_at IS NULL"
  ).bind(channelId, organizationId).first<{ is_default: number }>();
  assert(channel, 404, "channel_not_found", "Channel not found");
  assert(channel.is_default !== 1, 409, "default_channel", "The default channel cannot be deleted");
  const now = Date.now();
  const cleanupJobId = `channel:${channelId}`;
  const db = primaryDb(env);
  await db.batch([
    db.prepare("UPDATE channels SET deleted_at = ?, archived_at = ?, updated_at = ? WHERE id = ?").bind(now, now, now, channelId),
    db.prepare(
      `INSERT INTO cleanup_jobs (id, kind, target_id, status, created_at) VALUES (?, 'channel', ?, 'pending', ?)
       ON CONFLICT(id) DO UPDATE SET status = 'pending', completed_at = NULL`
    ).bind(cleanupJobId, channelId, now)
  ]);
  await env.CHANNELS.getByName(channelId).purge();
  await env.CLEANUP_QUEUE.send({ jobId: cleanupJobId, kind: "channel", targetId: channelId });
  await audit(env, organizationId, auth.user.id, "channel.deleted", "channel", channelId);
  return new Response(null, { status: 204 });
}

export async function channelForMember(
  env: Env,
  organizationId: string,
  channelId: string,
  userId: string,
  allowArchived = false
): Promise<ChannelRow> {
  await requireMembership(env, organizationId, userId);
  const row = await primaryDb(env).prepare(
    `SELECT id, organization_id, name, topic, archived_at, is_default, created_at FROM channels
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`
  ).bind(channelId, organizationId).first<ChannelRow>();
  assert(row && (allowArchived || row.archived_at === null), 404, "channel_not_found", "Active channel not found");
  return row;
}

export function isoOrNull(value: number | null): string | null {
  return toIso(value);
}
