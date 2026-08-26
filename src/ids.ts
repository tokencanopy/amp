import { randomBytes } from "node:crypto";

/**
 * Prefixed, monotonic ids.
 *
 * Time first so ids sort chronologically, then a per-process counter, then
 * randomness. The counter is load-bearing: several rows are routinely written
 * inside one millisecond (a meeting's participants, a burst of transcript
 * entries), and without it the random tail decides their relative order.
 *
 * Ordering in SQL does not depend on this — queries order by rowid, which is
 * the durable answer across processes — but ids that sort wrongly are a trap
 * for anything that sorts them in memory.
 */
let counter = 0;

export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffffff;
  const stamp = Date.now().toString(36).padStart(9, "0");
  const sequence = counter.toString(36).padStart(5, "0");
  return `${prefix}_${stamp}${sequence}${randomBytes(4).toString("hex")}`;
}
