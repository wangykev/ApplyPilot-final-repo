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

/** Workday's account-creation password policy. Enforced when SETTING credentials (not when
 *  reading them back — an old weak password must still load) so first-run account creation
 *  never fails the password rules. Kept as a plain list so the UI can render a live checklist
 *  and the save action can gate on the same source of truth. */
export type PasswordRequirement = { id: string; label: string; met: boolean };
export function passwordRequirements(pw: string): PasswordRequirement[] {
  const p = pw ?? "";
  return [
    { id: "len", label: "At least 8 characters", met: p.length >= 8 },
    { id: "lower", label: "A lowercase letter", met: /[a-z]/.test(p) },
    { id: "upper", label: "An uppercase letter", met: /[A-Z]/.test(p) },
    { id: "alpha", label: "An alphabetic character", met: /[A-Za-z]/.test(p) },
    { id: "num", label: "A number", met: /[0-9]/.test(p) },
    { id: "special", label: "A special character", met: /[^A-Za-z0-9]/.test(p) },
  ];
}
export function passwordMeetsRequirements(pw: string): boolean {
  return passwordRequirements(pw).every((r) => r.met);
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
