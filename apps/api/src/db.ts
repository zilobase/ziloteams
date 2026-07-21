import type { MembershipRole } from "@ziloteams/contracts";
import { ApiError } from "./errors.js";

export interface AuthenticatedUserRow {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
  session_expires_at: number;
}

export interface MembershipRow {
  organization_id: string;
  user_id: string;
  role: MembershipRole;
}

export function primaryDb(env: Env): D1DatabaseSession {
  return env.DB.withSession("first-primary");
}

export async function requireMembership(
  env: Env,
  organizationId: string,
  userId: string
): Promise<MembershipRow> {
  const membership = await primaryDb(env)
    .prepare("SELECT organization_id, user_id, role FROM organization_members WHERE organization_id = ? AND user_id = ?")
    .bind(organizationId, userId)
    .first<MembershipRow>();
  if (!membership) throw new ApiError(403, "not_a_member", "You are not a member of this organization");
  return membership;
}

export async function requireAdmin(env: Env, organizationId: string, userId: string): Promise<MembershipRow> {
  const membership = await requireMembership(env, organizationId, userId);
  if (membership.role !== "admin") {
    throw new ApiError(403, "admin_required", "Organization administrator access is required");
  }
  return membership;
}

export function toIso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}
