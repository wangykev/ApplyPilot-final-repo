// Non-action helpers/types for the queue. Kept OUT of actions.ts because a
// "use server" module may only export async functions.

export type QueueItem = {
  id: string;
  url: string;
  status: "pending" | "active" | "done" | "error";
  position: number;
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
