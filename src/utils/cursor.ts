// Cursor-based (keyset) pagination utilities.
//
// Why keyset pagination instead of OFFSET/LIMIT:
//   OFFSET N still forces Postgres to scan and discard the first N rows
//   of the index on every request — page 500 at limit=100 means reading
//   and throwing away 50,000 rows before returning any. That cost grows
//   linearly with how deep the user pages, which is exactly the wrong
//   shape for a log viewer where "keep loading older logs" is the
//   primary interaction. Keyset pagination instead carries the last
//   seen (ts, id) forward and asks Postgres for "the next rows after
//   this point," which the (ts DESC, id DESC) index answers in
//   effectively constant time regardless of how many pages precede it.
//
// The cursor is intentionally opaque to the caller (base64 JSON) — the
// contract only requires it round-trips unchanged, so we're free to
// change its internal shape later without breaking clients.

export interface Cursor {
  ts: string; // ISO timestamp of the last row on the previous page
  id: string; // tiebreaker for rows sharing the same timestamp
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor | null {
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "ts" in parsed &&
      "id" in parsed &&
      typeof (parsed as Cursor).ts === "string" &&
      typeof (parsed as Cursor).id === "string" &&
      !Number.isNaN(Date.parse((parsed as Cursor).ts))
    ) {
      return parsed as Cursor;
    }
    return null;
  } catch {
    return null;
  }
}
