// Card sources other than Collector Crypt (docs/SOURCES.md). Everything here is pure, so every source,
// the worker and the gateway agree on what "the same card" means.

/** Where a price came from. Collector Crypt is the market Tenner trades on; the rest are read-only. */
export interface SourceInfo {
  id: string;
  label: string;
  /** Two or three letters for tight table cells. */
  short: string;
  /** Tenner can buy here. Only Collector Crypt. */
  tradable: boolean;
}

export const SOURCES: Record<string, SourceInfo> = {
  cc: { id: "cc", label: "Collector Crypt", short: "CC", tradable: true },
  ebay: { id: "ebay", label: "eBay", short: "eBay", tradable: false },
};

export const sourceInfo = (id: string): SourceInfo => SOURCES[id] ?? { id, label: id, short: id.slice(0, 4), tradable: false };

const GRADERS: Array<[string, string]> = [
  ["PSA", "PSA"], ["CGC", "CGC"], ["BGS", "BGS"], ["BECKETT", "BGS"], ["BVG", "BGS"], ["SGC", "SGC"], ["TAG", "TAG"], ["ACE", "ACE"],
];

/** "Beckett" and "BGS" are one grader. Unknown graders stay as written, upper case. */
export function normalGrader(grader: string | null | undefined): string | null {
  const text = String(grader ?? "").trim().toUpperCase();
  // eBay writes graders out in full: "Professional Sports Authenticator (PSA)".
  const g = (text.match(/\(([A-Z]{2,8})\)/)?.[1] ?? text).replace(/[^A-Z]/g, "");
  if (!g) return null;
  for (const [name, canonical] of GRADERS) if (g === name || g.startsWith(name)) return canonical;
  for (const [words, canonical] of FULL_NAMES) if (g.includes(words)) return canonical;
  return g;
}

const FULL_NAMES: Array<[string, string]> = [
  ["PROFESSIONALSPORTSAUTHENTICATOR", "PSA"], ["CERTIFIEDGUARANTY", "CGC"], ["BECKETT", "BGS"], ["SPORTSCARDGUARANTY", "SGC"],
];

/**
 * The one slab, wherever it is listed: grader plus certificate number. Null when either is missing or the
 * number is too short to be a real certificate (a seller typing "10" in the cert field).
 */
export function certKey(grader: string | null | undefined, cert: string | null | undefined): string | null {
  const g = normalGrader(grader);
  const digits = String(cert ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (!g || digits.length < 6) return null;
  return `${g}:${digits}`;
}

export interface CardIdentity {
  year: number | null;
  /** The number printed on the card, leading zeros dropped: "064" is "64", "XY122" stays. */
  number: string | null;
  /** Lower-case words of the card's own name, without grader, grade or set. */
  words: string[];
  /** The word that names the card ("shuckle"), which a listing elsewhere must contain. */
  main: string | null;
  grader: string | null;
  grade: number | null;
  japanese: boolean;
}

const GRADE_RE = /\b(PSA|CGC|BGS|BECKETT|SGC|TAG)\s*(?:GEM\s*MI?N?T\s*|GEM-?MT\s*|MINT\s*|PRISTINE\s*)?(10|[1-9](?:\.5)?)(?![\d.])/i;
const JAPANESE = /\bjapanese\b|\bjpn?\b|\bjapan\b/i;
const NOISE = new Set([
  "pokemon", "pokémon", "card", "cards", "tcg", "holo", "rare", "full", "art", "the", "of", "and", "1st", "edition", "first",
  "japanese", "english", "jpn", "promo", "reverse", "foil", "gem", "mint", "graded", "vmax", "vstar",
]);

export function cardNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = raw.trim().replace(/^#/, "").split("/")[0]!.toUpperCase();
  if (!n || n === "NA") return null;
  return /^\d+$/.test(n) ? String(Number(n)) : n.replace(/^([A-Z-]*?)0+(\d)/, "$1$2");
}

export function nameWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[-/&]/g, " ")
    .replace(/[^a-z0-9é ]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NOISE.has(w) && !/^\d+$/.test(w));
}

/**
 * What card a Collector Crypt name describes. CC names follow "YEAR #NUM NAME GRADER GRADE SET"
 * ("2025 #064 Shuckle CGC 10 Pristine Mega Symphonia - M1S - Japanese"), with the odd exception, so
 * every part is optional.
 */
export function ccIdentity(name: string, grader?: string | null, gradeNum?: number | null): CardIdentity {
  const year = name.match(/^\s*((?:19|20)\d{2})\b/);
  const yearEnd = year ? year.index! + year[0].length : 0;
  const num = name.match(/#\s*([A-Za-z0-9-]+)/);
  const grade = name.match(GRADE_RE);
  const gradeAt = grade?.index ?? name.length;
  const numEnd = num ? num.index! + num[0].length : yearEnd;
  // Usually the name sits between the number and the grade. Some names put it before the number instead
  // ("2026 Pokemon Mega Evolution Promo ... Squirtle #39 CGC 9.5"), and then the word nearest the number is the card.
  let words = nameWords(name.slice(numEnd, Math.max(numEnd, gradeAt)));
  let main = words[0] ?? null;
  if (words.length === 0 && num) {
    words = nameWords(name.slice(yearEnd, num.index));
    main = words.at(-1) ?? null;
  }
  return {
    year: year ? Number(year[1]) : null,
    number: cardNumber(num?.[1]),
    words,
    main,
    grader: normalGrader(grader) ?? normalGrader(grade?.[1]),
    grade: gradeNum ?? (grade ? Number(grade[2]) : null),
    japanese: JAPANESE.test(name),
  };
}

/** Same card, grader and grade, so one's price is a fair comp for the other. The same for every source. */
export function cardKey(id: CardIdentity): string | null {
  if (!id.number || !id.grader || id.grade === null || !id.main) return null;
  return [id.main, id.number, id.japanese ? "jp" : "en", id.grader, id.grade].join("|");
}

/**
 * Whether a listing title elsewhere (eBay's are free text) is the card `want` describes. Strict on purpose: a
 * wrong comp is worse than none. Grader, grade and card number must all appear, so must the word that names
 * the card, and a Japanese card only matches a Japanese listing.
 */
export function titleMatches(want: CardIdentity, title: string, aspects: { grader?: string | null; grade?: number | null } = {}): boolean {
  if (!want.number || !want.grader || want.grade === null || !want.main) return false;
  const found = title.match(GRADE_RE);
  const grader = normalGrader(aspects.grader) ?? normalGrader(found?.[1]);
  const grade = aspects.grade ?? (found ? Number(found[2]) : null);
  if (grader !== want.grader || grade !== want.grade) return false;
  if (want.japanese !== JAPANESE.test(title)) return false;
  const lower = title.toLowerCase();
  if (!new RegExp(`\\b${want.main}\\b`).test(lower)) return false;
  // Grades and years look like card numbers ("PSA 10", "2023"), so they are taken out first.
  const rest = lower.replace(new RegExp(GRADE_RE.source, "gi"), " ").replace(/\b(19|20)\d{2}\b/g, " ");
  const num = want.number.toLowerCase();
  const numRe = /^\d+$/.test(num)
    ? new RegExp(`(?:^|[^\\d.])0*${num}(?:\\s*/\\s*\\d+)?(?![\\d.])`)
    : new RegExp(`(?:^|[^a-z0-9])${num.replace(/-/g, "\\-")}(?![a-z0-9])`);
  return numRe.test(rest);
}

/** The cheapest ask and the latest sale from one source, as shown next to a Collector Crypt price. */
export interface Elsewhere {
  source: string;
  /** "cert" is this very slab; "card" is the same card in the same grade. */
  match: "cert" | "card";
  ask: number | null;
  askUrl: string | null;
  asks: number;
  sold: number | null;
  soldAt: string | null;
  soldUrl: string | null;
}

/** How much cheaper (positive) or dearer (negative) the Collector Crypt price is than the cheapest ask elsewhere. */
export function gapPct(ccPrice: number, elsewhere: number | null): number | null {
  if (!elsewhere || elsewhere <= 0) return null;
  return Math.round((1 - ccPrice / elsewhere) * 100);
}
