import { z } from "zod";

/** Mirrors the extension's chrome.storage.local `credentials` — the Workday account
 *  the onboarding walk signs in with (or creates). Password stored as given. */
export const credentialsSchema = z.object({
  email: z.string().trim().default(""),
  password: z.string().default(""),
});
export type Credentials = z.infer<typeof credentialsSchema>;

export function emptyCredentials(): Credentials {
  return credentialsSchema.parse({});
}
export function coerceCredentials(raw: unknown): Credentials {
  const parsed = credentialsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyCredentials();
}

/** The subset of the extension's onboardConfig the website owns: the Gmail
 *  auto-verify toggle. (continueToWalk / startUrl stay popup-only — the website
 *  Run passes the URL directly and always walks to review.) */
export const onboardConfigSchema = z.object({
  gmailEnabled: z.boolean().default(false),
});
export type OnboardConfig = z.infer<typeof onboardConfigSchema>;

export function emptyOnboardConfig(): OnboardConfig {
  return onboardConfigSchema.parse({});
}
export function coerceOnboardConfig(raw: unknown): OnboardConfig {
  const parsed = onboardConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyOnboardConfig();
}
