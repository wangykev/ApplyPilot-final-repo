// Non-action helpers/types for the queue. Kept OUT of actions.ts because a
// "use server" module may only export async functions.

export type QueueItem = {
  id: string;
  url: string;
  status: "pending" | "active" | "done" | "error";
  position: number;
  // Discovery columns (migration 0010). A row the operator PASTED leaves these
  // null; a row the Discover sweep added carries where it came from, when it was
  // posted, and the description the extension scraped by opening the posting.
  company?: string | null;
  role?: string | null;
  source?: string | null;
  location?: string | null;
  posted_at?: string | null;
  job_description?: string | null;
};

/** Pull http(s) URLs out of pasted text (one per line or whitespace-separated). */
export function parseUrls(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => /^https?:\/\/\S+$/i.test(t))
    )
  );
}
