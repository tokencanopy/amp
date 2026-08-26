/**
 * Meeting context: what the agent is told about the room when it is addressed.
 *
 * Everything here is extractive and deterministic — counted terms, quoted
 * lines, recorded memories. Nothing is model-generated, which matters for two
 * reasons: a summary produced by a model would need a model call per
 * utterance (expensive and slow in a live meeting), and a *hallucinated*
 * summary handed to the agent as fact is worse than no summary at all. The
 * agent gets the room's own words, attributed, plus the decisions people
 * actually recorded.
 */
import type { MeetingMemory, TranscriptEntry } from "../domain.js";

/** Words too common to be a topic. */
const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "all",
  "also",
  "and",
  "any",
  "are",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "but",
  "can",
  "could",
  "did",
  "does",
  "doing",
  "done",
  "down",
  "each",
  "even",
  "every",
  "for",
  "from",
  "get",
  "gets",
  "getting",
  "going",
  "gonna",
  "got",
  "had",
  "has",
  "have",
  "having",
  "her",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "into",
  "its",
  "itself",
  "just",
  "kind",
  "know",
  "like",
  "look",
  "made",
  "make",
  "many",
  "may",
  "maybe",
  "mean",
  "might",
  "more",
  "most",
  "much",
  "must",
  "need",
  "not",
  "now",
  "off",
  "one",
  "only",
  "other",
  "our",
  "ours",
  "out",
  "over",
  "own",
  "really",
  "right",
  "said",
  "same",
  "say",
  "see",
  "she",
  "should",
  "some",
  "something",
  "still",
  "such",
  "sure",
  "take",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "think",
  "this",
  "those",
  "through",
  "too",
  "under",
  "until",
  "very",
  "want",
  "was",
  "way",
  "well",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "yeah",
  "yes",
  "you",
  "your",
  "yours",
]);

const WORD = /[\p{L}][\p{L}\p{N}'-]{2,}/gu;

/**
 * The most-used significant term across recent utterances, which is a decent
 * stand-in for "what are we talking about right now". Ties break toward the
 * more recent term, so the topic tracks the conversation rather than lagging
 * behind it.
 */
export function deriveTopic(
  entries: readonly TranscriptEntry[],
  window = 8,
): string | null {
  const recent = entries.slice(-window);
  if (recent.length === 0) return null;

  const counts = new Map<string, { count: number; lastSeen: number }>();
  recent.forEach((entry, index) => {
    for (const match of entry.text.toLowerCase().matchAll(WORD)) {
      const word = match[0];
      if (STOPWORDS.has(word)) continue;
      const existing = counts.get(word);
      if (existing === undefined)
        counts.set(word, { count: 1, lastSeen: index });
      else {
        existing.count += 1;
        existing.lastSeen = index;
      }
    }
  });

  let best: { word: string; count: number; lastSeen: number } | null = null;
  for (const [word, stats] of counts) {
    if (
      best === null ||
      stats.count > best.count ||
      (stats.count === best.count && stats.lastSeen > best.lastSeen)
    ) {
      best = { word, count: stats.count, lastSeen: stats.lastSeen };
    }
  }
  // A term used once is not a topic, it is a word.
  return best !== null && best.count > 1 ? best.word : null;
}

/**
 * A rolling digest of the meeting: who has been speaking, what was decided,
 * what was assigned. Quoted material only.
 */
export function buildRollingSummary(
  entries: readonly TranscriptEntry[],
  memories: readonly MeetingMemory[],
): string {
  if (entries.length === 0 && memories.length === 0) return "";

  const lines: string[] = [];
  if (entries.length > 0) {
    const speakers = [...new Set(entries.map((entry) => entry.speakerName))];
    lines.push(
      `${entries.length} utterance(s) so far from ${speakers.length} speaker(s): ${speakers.join(", ")}.`,
    );
  }

  const active = memories.filter((memory) => memory.status === "active");
  const decisions = active.filter((memory) => memory.kind === "decision");
  const actions = active.filter((memory) => memory.kind === "action_item");

  if (decisions.length > 0) {
    lines.push("Decisions:");
    lines.push(...decisions.map((memory) => `- ${memory.content}`));
  }
  if (actions.length > 0) {
    lines.push("Action items:");
    lines.push(...actions.map((memory) => `- ${memory.content}`));
  }
  return lines.join("\n");
}
