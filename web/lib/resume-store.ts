import { createHash } from "node:crypto";

/**
 * The résumé store — every read and write of the `resumes` table goes through here.
 *
 * WHY THIS EXISTS. Uploading used to be: overwrite the bytes at a fixed path (`<uid>/default-resume.pdf`,
 * `<uid>/source.tex`) and DELETE the previous row. That makes a résumé unreferenceable: an application
 * that recorded "sent with your résumé" silently resolves to whatever document you uploaded LAST, and the
 * row it pointed at is gone. The record breaks exactly when you would want it — months later, looking at
 * what you actually sent someone.
 *
 * So résumés are now VERSIONED and CONTENT-ADDRESSED:
 *   • the storage path contains the content hash, so a new upload can never overwrite old bytes
 *   • rows are kept; the CURRENT résumé of a kind is the newest one that is not soft-deleted
 *   • re-uploading identical bytes reuses the existing row instead of piling up duplicates
 *
 * Six call sites used to hard-code paths and delete rows. Centralising it here is what makes
 * "which résumé was this application sent with?" answerable at all.
 */

export type ResumeKind = "default" | "source" | "variant";

export type ResumeRow = {
  id: string;
  user_id: string;
  kind: ResumeKind;
  filename: string;
  mime: string;
  size: number;
  storage_path: string;
  sha256: string | null;
  created_at: string;
};

const COLS = "id, user_id, kind, filename, mime, size, storage_path, sha256, created_at";

/** Anything the Supabase client accepts here; the routes pass their own server/service client. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export function sha256Hex(bytes: Uint8Array | Buffer | string): string {
  return createHash("sha256").update(Buffer.from(bytes as Uint8Array)).digest("hex");
}

/** `<uid>/<kind>-<hash12>.<ext>` — the hash in the path is what makes a write non-destructive. */
export function resumePath(userId: string, kind: ResumeKind, sha: string, ext: string): string {
  return `${userId}/${kind}-${sha.slice(0, 12)}.${ext.replace(/^\./, "")}`;
}

/**
 * The résumé currently in force for a kind: newest, not soft-deleted.
 * `.limit(1)` matters — maybeSingle() ERRORS on multiple rows, and multiple rows is now the normal
 * state of this table rather than an anomaly.
 */
export async function currentResume(db: Db, userId: string, kind: ResumeKind): Promise<ResumeRow | null> {
  const { data } = await db
    .from("resumes")
    .select(COLS)
    .eq("user_id", userId)
    .eq("kind", kind)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ResumeRow) ?? null;
}

/** A specific résumé by id, ownership-checked. Soft-deleted rows ARE returned: an application that
 *  was sent with a résumé you have since removed must still be able to show it. */
export async function resumeById(db: Db, userId: string, id: string): Promise<ResumeRow | null> {
  const { data } = await db.from("resumes").select(COLS).eq("id", id).eq("user_id", userId).maybeSingle();
  return (data as ResumeRow) ?? null;
}

/**
 * Store bytes as the newest résumé of a kind. Identical content reuses the existing row — re-syncing or
 * re-saving an unchanged résumé should not create a new version, and dedup keeps one copy of the bytes
 * however many applications reference it.
 */
export async function putResume(
  db: Db,
  userId: string,
  kind: ResumeKind,
  file: { filename: string; mime: string; bytes: Uint8Array | Buffer; ext: string }
): Promise<{ ok: true; row: ResumeRow } | { ok: false; error: string }> {
  const bytes = Buffer.from(file.bytes as Uint8Array);
  const sha = sha256Hex(bytes);

  const { data: existing } = await db
    .from("resumes")
    .select(COLS)
    .eq("user_id", userId)
    .eq("kind", kind)
    .eq("sha256", sha)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    // Same bytes already current. Only the display name can differ (the user renamed the attachment).
    if (existing.filename !== file.filename) {
      await db.from("resumes").update({ filename: file.filename }).eq("id", existing.id);
      existing.filename = file.filename;
    }
    return { ok: true, row: existing as ResumeRow };
  }

  const path = resumePath(userId, kind, sha, file.ext);
  // upsert is safe BECAUSE the path is content-addressed: the only thing that can already be there is
  // these exact bytes (a row that was soft-deleted, or an interrupted earlier write).
  const { error: upErr } = await db.storage
    .from("resumes")
    .upload(path, bytes, { upsert: true, contentType: file.mime });
  if (upErr) return { ok: false, error: "Upload failed: " + upErr.message };

  const { data: row, error: insErr } = await db
    .from("resumes")
    .insert({
      user_id: userId,
      kind,
      filename: file.filename,
      mime: file.mime,
      size: bytes.length,
      storage_path: path,
      sha256: sha,
    })
    .select(COLS)
    .single();
  if (insErr) return { ok: false, error: insErr.message };
  return { ok: true, row: row as ResumeRow };
}

/**
 * "I removed my résumé." Soft-deletes EVERY live row of that kind — not just the newest, or the one
 * before it would silently become current again and the résumé would appear to come back. The bytes and
 * rows stay so applications that referenced them still resolve.
 */
export async function removeCurrentResume(db: Db, userId: string, kind: ResumeKind): Promise<void> {
  await db
    .from("resumes")
    .update({ deleted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("kind", kind)
    .is("deleted_at", null);
}

export async function signedUrlFor(db: Db, row: ResumeRow, seconds = 600): Promise<string | null> {
  const { data } = await db.storage.from("resumes").createSignedUrl(row.storage_path, seconds);
  return data?.signedUrl ?? null;
}

export async function downloadResume(db: Db, row: ResumeRow): Promise<Buffer | null> {
  const { data: blob } = await db.storage.from("resumes").download(row.storage_path);
  if (!blob) return null;
  return Buffer.from(await blob.arrayBuffer());
}
