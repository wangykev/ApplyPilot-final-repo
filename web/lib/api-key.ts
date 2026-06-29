import crypto from "node:crypto";

/** Server-only. The plaintext key is shown once (synced to the extension); only
 * its hash is stored in api_keys. */
export function generateApiKey(): string {
  return "apk_" + crypto.randomBytes(24).toString("hex");
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
