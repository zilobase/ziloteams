import { assert } from "./errors.js";

export async function serveRelease(path: string, env: Env): Promise<Response> {
  assert(path.length > 0 && !path.includes("..") && !path.startsWith("/"), 400, "invalid_release_path", "Invalid release path");
  const object = await env.RELEASES.get(path);
  assert(object?.body, 404, "release_not_found", "Release artifact not found");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  headers.set("cache-control", path.includes("latest") || path === "install.sh" ? "public, max-age=300" : "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
