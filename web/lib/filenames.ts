/** The user-chosen name for the GENERATED resume PDF — it's also the filename the
 *  extension attaches on applications, so keep it filesystem/portal-safe. */
export function sanitizePdfName(raw: string): string {
  let name = String(raw ?? "").trim();
  name = name.replace(/\.pdf$/i, "");
  name = name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").replace(/^-+|-+$/g, "").trim();
  if (!name) name = "resume";
  return name.slice(0, 80) + ".pdf";
}
