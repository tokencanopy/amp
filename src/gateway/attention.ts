/**
 * The attention engine: does this line of the meeting deserve an agent turn?
 *
 * A meeting produces a continuous stream of speech, and almost none of it is
 * for the agent. Forwarding every fragment would burn a model turn per
 * sentence and — worse — an agent that answers side conversation is one
 * nobody invites to a second meeting. So the default is silence, and the bar
 * for breaking it is deliberately high and entirely deterministic: no model
 * decides whether a model gets to speak.
 *
 * Three things earn a turn:
 *   1. a human explicitly marks an utterance as addressed to the agent
 *   2. a chat message directed at it (`@cofounder ...`)
 *   3. a wake name used *vocatively* AND followed by a question or an
 *      instruction
 *
 * Rule 3 carries all the difficulty, because a wake name is also an ordinary
 * noun in a meeting about coding agents. "I used Codex yesterday" names the
 * agent without addressing it; "We should ask the cofounder later" is a
 * proposal about the agent, made to the humans. Both must stay silent. The
 * grammar we exploit is that English marks direct address positionally: a
 * vocative sits at the edge of its clause and is not preceded by a determiner
 * or a verb.
 *
 * PUNCTUATION IS EVIDENCE, NEVER A PRECONDITION.
 *
 * The first version of this engine required the comma in "Cofounder, what do
 * you think?" — and that quietly assumed written text. Speech recognition
 * routinely emits "cofounder what do you think" with no punctuation and no
 * capitals, and measured against that input the strict rules lost six of
 * eight genuine addresses. They did not become wrong; they went deaf, which
 * in a meeting is just as useless.
 *
 * So punctuation now only ever *adds* confidence. When the comma is present
 * it settles the vocative outright. When it is absent the same decision is
 * made from syntax, which is what the punctuation was standing in for all
 * along:
 *
 *   - what follows a vocative is an imperative or a question, never a
 *     predicate — "cofounder summarize this" addresses it, "claude helped
 *     write this" talks about it, and the difference is that `helped` is a
 *     finite verb with the name as its subject;
 *   - a vocative is never the object of a preposition, which is what keeps
 *     "can you send this to codex" silent while "what do you think cofounder"
 *     is heard.
 *
 * Every rule here is tested twice, once punctuated and once as a caption
 * stream would emit it, and the two must agree. See `test/asr.test.ts`.
 */
import type { ParticipantKind } from "../domain.js";

export type AttentionReason =
  | "explicit_flag"
  | "chat_directed"
  | "wake_name"
  | "reply_to_agent"
  | "empty"
  | "agent_speaker"
  | "no_wake_name"
  | "mention_only"
  | "no_directive";

export interface AttentionDecision {
  triggered: boolean;
  reason: AttentionReason;
  matchedWakeName?: string;
  /** Human-readable justification, surfaced in the agent activity log. */
  detail: string;
}

export interface AttentionInput {
  text: string;
  channel: "speech" | "chat";
  /** The speaker ticked "address agent" in the UI, or a provider flagged it. */
  addressed: boolean;
  speakerKind: ParticipantKind;
  wakeNames: readonly string[];
  /**
   * The agent has just asked the room something and is owed an answer.
   *
   * Without this, a conversation can only ever be one exchange deep. The
   * agent asks "do you want me to check the retry path?", somebody says
   * "yes", and nothing happens — because "yes" carries no name and no
   * instruction, which is exactly what a person answering a question sounds
   * like. Requiring the name again on the reply is the tell that you are
   * talking to a machine.
   *
   * The caller decides when this is true, and it is deliberately narrow: only
   * after the agent ENDED ITS TURN ON A QUESTION, only for a short window,
   * and only until somebody speaks. A question hands the turn back
   * explicitly; a statement does not, and treating one as if it did would let
   * the agent barge into the conversation that carries on around it.
   */
  awaitingReply?: boolean;
}

/** Interjections that may precede a vocative without breaking it. */
const LEADING_FILLERS = new Set([
  "hey",
  "hi",
  "hello",
  "ok",
  "okay",
  "so",
  "um",
  "uh",
  "er",
  "well",
  "right",
  "alright",
  "yo",
  "and",
  "but",
  "also",
  "now",
]);

/**
 * Verbs that open an instruction. A vocative followed by one of these is an
 * order, not a remark. The list is intentionally finite and boring: a
 * heuristic that guesses at "verb-ness" produces exactly the false positives
 * this engine exists to avoid.
 */
const IMPERATIVE_VERBS = new Set([
  "add",
  "analyze",
  "analyse",
  "audit",
  "break",
  "check",
  "compare",
  "confirm",
  "describe",
  "dig",
  "draft",
  "estimate",
  "evaluate",
  "explain",
  "figure",
  "find",
  "fix",
  "give",
  "help",
  "inspect",
  "investigate",
  "list",
  "look",
  "note",
  "open",
  "outline",
  "plan",
  "prioritize",
  "prioritise",
  "propose",
  "pull",
  "recap",
  "remember",
  "remind",
  "remove",
  "review",
  "run",
  "sanity",
  "sketch",
  "show",
  "start",
  "suggest",
  "summarize",
  "summarise",
  "take",
  "tell",
  "track",
  "update",
  "verify",
  "walk",
  "weigh",
  "write",
]);

const SECOND_PERSON = new Set(["you", "your", "yours", "you're", "youre"]);

/**
 * Verb forms that can only be finite — a past tense or a third-person
 * singular. Immediately after a wake name, one of these means the name is the
 * SUBJECT of the clause, not the person being addressed: "claude helped write
 * this", "codex says the retry is fine". That distinction is what the comma
 * used to carry, and it is the single most important guard on unpunctuated
 * text, because without it any sentence that merely opens with the agent's
 * name reads as an instruction to it.
 *
 * A closed list rather than morphology: an "-ed/-s ending means finite" rule
 * misfires on ordinary imperatives ("update the doc", "focus on retries") and
 * would cost real triggers to catch a handful of extra mentions.
 */
const FINITE_VERB_FORMS = new Set([
  "answered",
  "answers",
  "asked",
  "asks",
  "believed",
  "believes",
  "brought",
  "built",
  "builds",
  "called",
  "calls",
  "came",
  "caught",
  "changed",
  "changes",
  "chose",
  "claimed",
  "claims",
  "closed",
  "did",
  "does",
  "drafted",
  "drops",
  "fixed",
  "fixes",
  "flagged",
  "flags",
  "found",
  "gave",
  "gets",
  "got",
  "had",
  "handled",
  "handles",
  "has",
  "helped",
  "helps",
  "is",
  "kept",
  "keeps",
  "knew",
  "knows",
  "left",
  "let",
  "liked",
  "likes",
  "looked",
  "looks",
  "made",
  "makes",
  "meant",
  "means",
  "mentioned",
  "mentions",
  "missed",
  "misses",
  "needed",
  "needs",
  "noted",
  "notes",
  "opened",
  "picked",
  "picks",
  "put",
  "ran",
  "reckons",
  "recommended",
  "recommends",
  "replied",
  "replies",
  "reported",
  "reports",
  "said",
  "says",
  "saw",
  "seemed",
  "seems",
  "sent",
  "sends",
  "shipped",
  "showed",
  "shows",
  "sounded",
  "sounds",
  "started",
  "starts",
  "suggested",
  "suggests",
  "thinks",
  "thought",
  "told",
  "took",
  "tried",
  "tries",
  "used",
  "uses",
  "walked",
  "wanted",
  "wants",
  "was",
  "went",
  "were",
  "wrote",
]);

/**
 * The only verbs after which a trailing name, with no comma, is read as a
 * vocative: opinion verbs that do not take a person as their object.
 *
 * This list is short on purpose, and the reason is a measurement. Admitting
 * any clause-final name after a directive turned "did you try codex", "when
 * did you last use codex" and "remind me to ping codex" into triggers — in
 * each, the name is the OBJECT of the verb before it, which is the ordinary
 * case, not the exception. Punctuation is what normally tells the two apart,
 * so with no comma to read the only safe move is to enumerate the handful of
 * verbs where the object reading is impossible: nobody thinks a cofounder or
 * feels a codex.
 *
 * The cost is stated plainly rather than hidden: on unpunctuated speech, a
 * trailing vocative is recognized for opinion questions ("what do you think
 * cofounder") and not otherwise. Every other trailing address needs the
 * comma, a leading vocative, or the explicit "address the agent" flag.
 */
const VOCATIVE_ENDERS = new Set([
  "think",
  "thinks",
  "reckon",
  "reckons",
  "feel",
  "feels",
  "suggest",
  "suggests",
  "recommend",
  "recommends",
  "advise",
  "say",
]);

/**
 * Openers that make a clause a question. The contracted forms are here
 * because speech recognition emits them constantly — "what's the retry
 * budget" is far more common out loud than "what is" — and a list that only
 * knows the uncontracted form is deaf to half of real speech.
 */
const QUESTION_OPENERS = new Set([
  "whats",
  "what's",
  "hows",
  "how's",
  "wheres",
  "where's",
  "whos",
  "who's",
  "whens",
  "when's",
  "whys",
  "why's",
  "anything",
  "anyone",
  "anybody",
  "what",
  "why",
  "how",
  "when",
  "where",
  "which",
  "who",
  "should",
  "can",
  "could",
  "would",
  "will",
  "do",
  "does",
  "did",
  "is",
  "are",
  "any",
]);

interface Token {
  /** Lowercased, punctuation stripped. */
  word: string;
  /** Punctuation immediately following the word, e.g. "," or ":" or "?". */
  trailing: string;
}

const WORD_EDGE = /^[^\p{L}\p{N}@'-]+|[^\p{L}\p{N}'-]+$/gu;

function tokenize(sentence: string): Token[] {
  return sentence
    .split(/\s+/u)
    .filter((raw) => raw !== "")
    .map((raw) => {
      const word = raw.replace(WORD_EDGE, "").toLowerCase();
      const trailingMatch = /[^\p{L}\p{N}'-]+$/u.exec(raw);
      return { word, trailing: trailingMatch === null ? "" : trailingMatch[0] };
    })
    .filter((token) => token.word !== "" || token.trailing !== "");
}

/** Split on sentence terminators, keeping the terminator with its sentence. */
export function splitSentences(text: string): string[] {
  const parts = text
    .replace(/\s+/gu, " ")
    .trim()
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts.length === 0 ? [] : parts;
}

function normalizeWake(name: string): string[] {
  return name
    .toLowerCase()
    .split(/\s+/u)
    .map((part) => part.replace(WORD_EDGE, ""))
    .filter((part) => part !== "");
}

interface WakeMatch {
  wakeName: string;
  start: number;
  end: number;
}

/**
 * A token reduced to the letters of the name inside it.
 *
 * Speech-to-text writes one spoken name several ways, and every one of these
 * was observed on a live call: "cofounder", "Co founder", "co-founder". The
 * hyphen and the "@" of a chat mention are punctuation around a name, not
 * part of it. Whole tokens only — a substring match would find "cofounder"
 * inside "discofounder", and a name matching inside an unrelated word is how
 * an agent starts answering things nobody asked it.
 */
function bareWord(word: string): string {
  return word.replace(/^@/u, "").replace(/[-\u2010-\u2015]/gu, "");
}

function findWake(
  tokens: Token[],
  wakeNames: readonly string[],
): WakeMatch | null {
  // Longest name first, so "claude code" wins over "claude".
  const candidates = wakeNames
    .map((name) => ({ name, parts: normalizeWake(name) }))
    .filter((candidate) => candidate.parts.length > 0)
    .sort((a, b) => b.parts.length - a.parts.length);

  for (let index = 0; index < tokens.length; index += 1) {
    for (const candidate of candidates) {
      const end = index + candidate.parts.length - 1;
      if (end >= tokens.length) continue;
      const matches = candidate.parts.every((part, offset) => {
        const token = tokens[index + offset];
        if (token === undefined) return false;
        // An "@codex" mention is still the bare name for matching purposes,
        // and a transcriber that writes "co-founder" for "cofounder" has not
        // used a different word — it has punctuated the same one. Compared
        // whole, never as a substring, so this cannot match inside another
        // word.
        return bareWord(token.word) === part;
      });
      if (matches) return { wakeName: candidate.name, start: index, end };
    }
  }

  // Speech-to-text splits compound names: "cofounder" comes back as
  // "co founder", and the name simply stops existing. Observed on a live call
  // and, until it was fixed, the agent went deaf to its own name.
  //
  // Matched by CONCATENATION over a short run of adjacent tokens, never by
  // substring: "cofounder" is a substring of "discofounder", and a name that
  // matches inside an unrelated word is how an agent starts answering things
  // nobody asked it.
  for (let index = 0; index < tokens.length; index += 1) {
    for (const candidate of candidates) {
      const target = candidate.parts.join("");
      for (let span = 2; span <= MAX_SPLIT_TOKENS; span += 1) {
        const end = index + span - 1;
        if (end >= tokens.length) break;
        let joined = "";
        for (let offset = 0; offset < span; offset += 1) {
          joined += bareWord(tokens[index + offset]?.word ?? "");
        }
        if (joined === target) {
          return { wakeName: candidate.name, start: index, end };
        }
      }
    }
  }
  return null;
}

/**
 * How many adjacent tokens may be joined when looking for a split name.
 *
 * Three covers what transcription actually does to a compound. Higher would
 * start joining unrelated words into an accidental match.
 */
const MAX_SPLIT_TOKENS = 3;

/**
 * Re-attach a vocative the vendor punctuated as its own sentence.
 *
 * A speaker pauses after saying a name, the vendor renders that pause as a
 * full stop, and the sentence splitter then separates the address from what
 * it introduced: "Cofounder. What do you think?" becomes one sentence naming
 * nobody's question and one question addressing nobody. Both are correctly
 * ignored, and the most natural way to address the agent goes unheard.
 *
 * Only a sentence that is NOTHING BUT the name (with the fillers speech opens
 * on) is treated this way. "I spoke to Claude." keeps other words, so it is
 * left alone — which is what stops this from becoming a way to trigger on any
 * mention followed by a question.
 */
function mergeBareVocatives(
  sentences: string[],
  wakeNames: readonly string[],
): string[] {
  const merged: string[] = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index] ?? "";
    const next = sentences[index + 1];
    if (next !== undefined && isBareVocative(sentence, wakeNames)) {
      merged.push(`${sentence.replace(/[.!?]+\s*$/u, "")}, ${next}`);
      index += 1;
      continue;
    }
    merged.push(sentence);
  }
  return merged;
}

/** A sentence consisting only of a wake name, give or take an opener. */
function isBareVocative(
  sentence: string,
  wakeNames: readonly string[],
): boolean {
  const tokens = tokenize(sentence).filter((token) => token.word !== "");
  let start = 0;
  while (
    start < tokens.length &&
    LEADING_FILLERS.has(tokens[start]?.word ?? "")
  ) {
    start += 1;
  }
  const rest = tokens.slice(start);
  if (rest.length === 0) return false;
  const match = findWake(rest, wakeNames);
  return match !== null && match.start === 0 && match.end === rest.length - 1;
}

/**
 * Does the remainder of the sentence ask for something?
 *
 * Leading fillers are stripped first. Speech starts with them constantly —
 * "so what do you think", "ok summarize that" — and without stripping, the
 * question opener and the imperative verb are never in first position on
 * spoken text even though a reader would hear both immediately.
 */
function hasDirective(
  rest: Token[],
  sentence: string,
  options: { addresseeEstablished?: boolean } = {},
): boolean {
  if (sentence.trim().endsWith("?")) return true;
  let start = 0;
  while (start < rest.length && LEADING_FILLERS.has(rest[start]?.word ?? "")) {
    start += 1;
  }
  const meaningful = rest.slice(start);
  const first = meaningful[0];
  if (first === undefined) return false;
  if (IMPERATIVE_VERBS.has(first.word)) return true;
  if (first.word === "please") return true;

  // A leading vocative has already named the addressee, so the clause after
  // it does not have to name them again. "codex what's the retry budget" and
  // "cofounder your thoughts" are both requests, and neither contains the
  // word "you" — requiring one was a proxy for "we know who is being spoken
  // to", which the vocative itself now supplies. Where the name comes at the
  // END instead, that proxy is still doing real work and stays.
  if (options.addresseeEstablished === true) {
    if (QUESTION_OPENERS.has(first.word)) return true;
    if (SECOND_PERSON.has(first.word)) return true;
  }
  const joined = meaningful.map((token) => token.word).join(" ");
  if (/\b(can|could|would|will) you\b/u.test(joined)) return true;
  if (/\b(please|go ahead)\b/u.test(joined)) return true;
  if (
    QUESTION_OPENERS.has(first.word) &&
    meaningful.some((t) => SECOND_PERSON.has(t.word))
  ) {
    return true;
  }
  return false;
}

/** The name is the subject of what follows, so it is being talked about. */
function isPredicate(rest: Token[]): boolean {
  const next = rest[0];
  return next !== undefined && FINITE_VERB_FORMS.has(next.word);
}

function endsWithVocativePunctuation(token: Token): boolean {
  return /[,:;—–-]/u.test(token.trailing);
}

/**
 * Decide on one sentence. Returns the matched wake name when the sentence
 * both addresses the agent and asks it for something.
 */
function evaluateSentence(
  sentence: string,
  wakeNames: readonly string[],
): { matched: string | null; reason: AttentionReason } {
  const tokens = tokenize(sentence);
  const match = findWake(tokens, wakeNames);
  if (match === null) return { matched: null, reason: "no_wake_name" };

  const before = tokens.slice(0, match.start);
  const rest = tokens.slice(match.end + 1);
  const nameToken = tokens[match.end];
  if (nameToken === undefined) return { matched: null, reason: "no_wake_name" };

  // An "@name" mention in chat is address by construction — nobody types an
  // at-mention about someone.
  const atMention = tokens[match.start]?.word.startsWith("@") === true;

  // Leading vocative: the name opens the sentence, possibly after fillers
  // ("hey", "ok", "so"). Anything else before it — a determiner, a
  // preposition, a verb — means the name is being talked about, not to.
  const leadingVocative = before.every((token) =>
    LEADING_FILLERS.has(token.word),
  );
  // Trailing vocative: "what do you think, cofounder?" — or, with no comma to
  // rely on, the name ending an opinion question. See VOCATIVE_ENDERS for why
  // the unpunctuated form is deliberately narrow.
  const previous = before[before.length - 1];
  const commaBefore = previous !== undefined && /[,]/u.test(previous.trailing);
  const nameEndsUtterance = rest.length === 0 && before.length > 0;
  const openToVocative =
    previous !== undefined && VOCATIVE_ENDERS.has(previous.word);
  const trailingVocative = commaBefore || (nameEndsUtterance && openToVocative);

  if (!leadingVocative && !trailingVocative && !atMention) {
    return { matched: null, reason: "mention_only" };
  }

  if (atMention) return { matched: match.wakeName, reason: "wake_name" };

  if (leadingVocative) {
    // "Cofounder, what do you think?" — and equally "cofounder what do you
    // think", where the comma never arrived.
    //
    // The punctuation buys one thing only: it skips the predicate guard. With
    // a comma, "Claude, helped write this" is not a sentence anyone speaks;
    // without one, "claude helped write this" is a remark about Claude and
    // must stay silent. Beyond that both forms face the same directive test,
    // which is what stopped this rule depending on a comma that speech
    // recognition never supplies.
    if (!endsWithVocativePunctuation(nameToken) && isPredicate(rest)) {
      return { matched: null, reason: "mention_only" };
    }
    return hasDirective(rest, sentence, { addresseeEstablished: true })
      ? { matched: match.wakeName, reason: "wake_name" }
      : { matched: null, reason: "no_directive" };
  }

  // Trailing: the request is the clause that came before the name.
  return hasDirective(before, sentence)
    ? { matched: match.wakeName, reason: "wake_name" }
    : { matched: null, reason: "no_directive" };
}

const silent = (
  reason: AttentionReason,
  detail: string,
): AttentionDecision => ({
  triggered: false,
  reason,
  detail,
});

/**
 * Did this turn end by handing the conversation back?
 *
 * A question mark at the very end is the signal, and the position is the
 * point: an agent that mentions a question mid-answer and then carries on
 * ("should we retry? we already do, three times") has not stopped talking,
 * while one that finishes on a question is waiting. Trailing quotes and
 * brackets are stripped because a question can close inside them.
 *
 * Cheap and shallow on purpose. The cost of being wrong is one repetition of
 * the agent's name, which is what the room already does today.
 */
export function endsWithQuestion(text: string): boolean {
  const trimmed = text.trim().replace(/["'’”)\]]+$/u, "");
  return trimmed.endsWith("?");
}

export function decideAttention(input: AttentionInput): AttentionDecision {
  const text = input.text.trim();
  if (text === "") return silent("empty", "nothing was said");

  // An agent never triggers itself. Without this the room fills with two
  // agents answering each other, and one of them is ours.
  if (input.speakerKind === "agent") {
    return silent("agent_speaker", "the agent does not answer itself");
  }

  if (input.addressed) {
    return {
      triggered: true,
      reason: "explicit_flag",
      detail: "the speaker marked this as addressed to the agent",
    };
  }

  // The agent asked; this is somebody answering. A reply does not repeat the
  // name — "yes" is a complete answer to a question, and demanding "Cofounder,
  // yes" is the difference between a conversation and a command line. Checked
  // before the wake-name rules because a reply satisfies none of them.
  if (input.awaitingReply === true) {
    return {
      triggered: true,
      reason: "reply_to_agent",
      detail: "answering the question the agent just asked",
    };
  }

  let lastReason: AttentionReason = "no_wake_name";
  for (const sentence of mergeBareVocatives(
    splitSentences(text),
    input.wakeNames,
  )) {
    const outcome = evaluateSentence(sentence, input.wakeNames);
    if (outcome.matched !== null) {
      const chatDirected =
        input.channel === "chat" && sentence.trimStart().startsWith("@");
      return {
        triggered: true,
        reason: chatDirected ? "chat_directed" : "wake_name",
        matchedWakeName: outcome.matched,
        detail: chatDirected
          ? `chat message directed at "${outcome.matched}"`
          : `"${outcome.matched}" addressed directly with a question or instruction`,
      };
    }
    if (outcome.reason !== "no_wake_name") lastReason = outcome.reason;
  }

  const details: Record<AttentionReason, string> = {
    explicit_flag: "",
    chat_directed: "",
    wake_name: "",
    reply_to_agent: "",
    empty: "",
    agent_speaker: "",
    no_wake_name: "no wake name was used",
    mention_only: "the agent was mentioned, not addressed",
    no_directive: "the agent was addressed but nothing was asked",
  };
  return silent(lastReason, details[lastReason]);
}
