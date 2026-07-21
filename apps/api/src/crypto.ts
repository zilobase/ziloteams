const encoder = new TextEncoder();
const BASE32_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function randomOtp(): string {
  const values = new Uint32Array(1);
  const unbiasedLimit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(values); while ((values[0] ?? unbiasedLimit) >= unbiasedLimit);
  return String((values[0] ?? 0) % 1_000_000).padStart(6, "0");
}

export function randomInviteCode(): string {
  let code = "";
  const unbiasedLimit = Math.floor(256 / BASE32_ALPHABET.length) * BASE32_ALPHABET.length;
  while (code.length < 16) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < unbiasedLimit) code += BASE32_ALPHABET[byte % BASE32_ALPHABET.length];
      if (code.length === 16) break;
    }
  }
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function normalizeInviteCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function secureHexEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  const leftBytes = Uint8Array.from(leftHash.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  const rightBytes = Uint8Array.from(rightHash.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}
