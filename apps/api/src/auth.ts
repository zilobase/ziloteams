import { isValidEmail, normalizeEmail, optionalString, requiredString, type User } from "@ziloteams/contracts";
import { hmacHex, randomOtp, randomToken, secureHexEqual, sha256Hex } from "./crypto.js";
import { primaryDb, type AuthenticatedUserRow } from "./db.js";
import { ApiError, assert } from "./errors.js";
import { readJsonObject } from "./http.js";

const OTP_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const OTP_RESEND_MS = 60_000;
const OTP_HOURLY_LIMIT = 5;

export interface AuthContext {
  user: AuthenticatedUserRow;
  tokenHash: string;
}

export async function requestOtp(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const email = normalizeEmail(requiredString(body, "email", { max: 254 }));
  assert(isValidEmail(email), 400, "invalid_email", "Enter a valid email address");

  const now = Date.now();
  const db = primaryDb(env);
  const latest = await db
    .prepare("SELECT created_at FROM auth_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1")
    .bind(email)
    .first<{ created_at: number }>();
  assert(!latest || now - latest.created_at >= OTP_RESEND_MS, 429, "otp_cooldown", "Wait before requesting another code");

  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM auth_challenges WHERE email = ? AND created_at >= ?")
    .bind(email, now - 60 * 60_000)
    .first<{ count: number }>();
  assert((count?.count ?? 0) < OTP_HOURLY_LIMIT, 429, "otp_rate_limited", "Too many verification requests");

  const code = randomOtp();
  const challengeId = crypto.randomUUID();
  const digest = await hmacHex(env.OTP_HMAC_KEY, `${email}:${code}`);
  await db.prepare(
    "INSERT INTO auth_challenges (id, email, code_digest, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(challengeId, email, digest, now + OTP_TTL_MS, now).run();

  try {
    await env.EMAIL.send({
      to: email,
      from: { email: env.OTP_SENDER, name: "ZiloTeams" },
      subject: `${code} is your ZiloTeams verification code`,
      text: `Your ZiloTeams verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your ZiloTeams verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes.</p>`
    });
  } catch (error) {
    await db.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(challengeId).run();
    console.error(JSON.stringify({ message: "otp_delivery_failed", challengeId, error: error instanceof Error ? error.message : String(error) }));
    throw new ApiError(503, "email_unavailable", "The verification email could not be sent");
  }

  return Response.json({ ok: true }, { status: 202 });
}

export async function verifyOtp(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const email = normalizeEmail(requiredString(body, "email", { max: 254 }));
  const code = requiredString(body, "code", { min: 6, max: 6 });
  const requestedDisplayName = optionalString(body, "displayName", 40);
  const now = Date.now();
  const db = primaryDb(env);
  const challenge = await db.prepare(
    `SELECT id, code_digest, attempts_remaining, expires_at
     FROM auth_challenges
     WHERE email = ? AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).bind(email).first<{ id: string; code_digest: string; attempts_remaining: number; expires_at: number }>();

  assert(challenge && challenge.expires_at > now && challenge.attempts_remaining > 0, 401, "invalid_otp", "The verification code is invalid or expired");
  const providedDigest = await hmacHex(env.OTP_HMAC_KEY, `${email}:${code}`);
  if (!(await secureHexEqual(providedDigest, challenge.code_digest))) {
    await db.prepare("UPDATE auth_challenges SET attempts_remaining = attempts_remaining - 1 WHERE id = ?")
      .bind(challenge.id).run();
    throw new ApiError(401, "invalid_otp", "The verification code is invalid or expired");
  }

  let user = await db.prepare(
    "SELECT id, email, display_name, created_at FROM users WHERE email = ?"
  ).bind(email).first<{ id: string; email: string; display_name: string; created_at: number }>();

  if (!user) {
    const userId = crypto.randomUUID();
    const displayName = requestedDisplayName ?? email.split("@")[0] ?? "Member";
    assert(displayName.length >= 2, 400, "invalid_display_name", "Display name must contain at least two characters");
    await db.prepare(
      "INSERT INTO users (id, email, display_name, email_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, email, displayName, now, now, now).run();
    user = { id: userId, email, display_name: displayName, created_at: now };
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const sessionId = crypto.randomUUID();
  const sessionResults = await db.batch([
    db.prepare("UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").bind(now, challenge.id),
    db.prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sessionId, tokenHash, user.id, now + SESSION_TTL_MS, now)
  ]);
  assert(sessionResults[0]?.meta.changes === 1, 409, "otp_already_used", "The verification code was already used");

  const responseUser: User = {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: new Date(user.created_at).toISOString()
  };
  return Response.json({ token, expiresAt: new Date(now + SESSION_TTL_MS).toISOString(), user: responseUser });
}

export async function authenticate(request: Request, env: Env): Promise<AuthContext> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new ApiError(401, "authentication_required", "Sign in to continue");
  }
  const token = authorization.slice(7).trim();
  assert(token.length >= 32, 401, "invalid_session", "Your session is invalid or expired");
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const user = await primaryDb(env).prepare(
    `SELECT users.id, users.email, users.display_name, users.created_at, sessions.expires_at AS session_expires_at
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
  ).bind(tokenHash, now).first<AuthenticatedUserRow>();
  if (!user) throw new ApiError(401, "invalid_session", "Your session is invalid or expired");
  return { user, tokenHash };
}

export async function logout(auth: AuthContext, env: Env): Promise<Response> {
  await primaryDb(env).prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
  return new Response(null, { status: 204 });
}

export async function getMe(auth: AuthContext): Promise<Response> {
  const user: User = {
    id: auth.user.id,
    email: auth.user.email,
    displayName: auth.user.display_name,
    createdAt: new Date(auth.user.created_at).toISOString()
  };
  return Response.json({ user });
}

export async function updateMe(request: Request, auth: AuthContext, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const displayName = requiredString(body, "displayName", { min: 2, max: 40 });
  await primaryDb(env).prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
    .bind(displayName, Date.now(), auth.user.id).run();
  return Response.json({ user: { id: auth.user.id, email: auth.user.email, displayName, createdAt: new Date(auth.user.created_at).toISOString() } });
}
