type RequestBody = {
  sbvText?: string;
  italicsText?: string;   // one phrase per line
  outputName?: string;
};

function vttResponse(vtt: string, filename = "captions.vtt") {
  return new Response(vtt, {
    status: 200,
    headers: {
      "content-type": "text/vtt; charset=utf-8",
      "content-disposition": `attachment; filename="${sanitizeFilename(filename)}"`,
      "cache-control": "no-store",
    },
  });
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sanitizeFilename(name: string) {
  const cleaned = name.replace(/[^\w.\-() ]+/g, "_").trim();
  return cleaned.toLowerCase().endsWith(".vtt") ? cleaned : `${cleaned || "captions"}.vtt`;
}

function normalizeHour(ts: string) {
  const m = ts.match(/^(\d+):(\d{2}):(\d{2}\.\d{3})$/);
  if (!m) return ts;
  const h = m[1].padStart(2, "0");
  return `${h}:${m[2]}:${m[3]}`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c] as string));
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * We want "whole word / whole phrase" matches, not substrings.
 * Define a "word character" as any Unicode letter or digit.
 * Boundary = start/end OR a non-letter/digit around the match.
 *
 * Note: JS supports Unicode property escapes with /u.
 */
const WORD_CH = String.raw`[\p{L}\p{N}]`;
const NOT_WORD_CH = String.raw`[^\p{L}\p{N}]`;

/**
 * Build one regex that matches ANY phrase/word from the italics list,
 * but only when it is bounded by non-word chars (or start/end).
 *
 * We use a capturing group for the match itself, and keep the left boundary
 * so we can re-emit it unchanged.
 *
 * Pattern shape:
 *   (^|NOT_WORD)(PHRASE1|PHRASE2|...)(?=$|NOT_WORD)
 *
 * We also collapse whitespace inside phrases to match flexible spaces:
 * "Manduky   Upanishad" in text should match "Manduky Upanishad" in list.
 */
function buildItalicsRegex(phrases: string[]): RegExp | null {
  if (!phrases.length) return null;

  // longest-first so phrases win over smaller words
  const sorted = [...phrases].sort((a, b) => b.length - a.length);

  const alts = sorted.map(p => {
    // trim and normalize internal whitespace in the phrase to \s+
    const norm = p.trim().replace(/\s+/g, String.raw`\s+`);
    return escapeRegex(norm)
      // escapeRegex also escaped \s+ we inserted, so undo that:
      .replace(/\\s\+/g, String.raw`\s+`);
  });

  const pattern = String.raw`(^|${NOT_WORD_CH})(${alts.join("|")})(?=$|${NOT_WORD_CH})`;
  return new RegExp(pattern, "giu"); // g=global, i=case-insensitive, u=unicode
}

function buildItalicsList(italicsText: string): string[] {
  return italicsText
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Italicize only whole-word/whole-phrase matches.
 * Also: avoid double-italicizing by doing everything in ONE regex pass.
 *
 * Steps:
 * 1) HTML-escape the full line (to avoid accidental HTML injection)
 * 2) Run italics regex over the *escaped line* but we must match phrases
 *    against the visible text, not against escape sequences.
 *
 * To keep it simple & robust:
 * - We do matching on the raw line
 * - We build an output string with safe escaping for non-matched parts,
 *   and <i>...</i> for matched parts.
 */
function italicizeLineWholeWords(rawLine: string, italicsRe: RegExp | null): string {
  if (!italicsRe) return escapeHtml(rawLine);
  italicsRe.lastIndex = 0;

  let out = "";
  let last = 0;

  // We match on the RAW line, but we need to preserve group(1) boundary char.
  // match[0] includes boundary + phrase; group1 is boundary; group2 is phrase.
  for (const match of rawLine.matchAll(italicsRe)) {
    const full = match[0] ?? "";
    const leftBoundary = match[1] ?? "";
    const phrase = match[2] ?? "";

    const startIdx = match.index ?? 0;
    // full match starts at startIdx; phrase starts after leftBoundary
    const phraseStart = startIdx + leftBoundary.length;
    const phraseEnd = phraseStart + phrase.length;

    // append text before the match
    out += escapeHtml(rawLine.slice(last, phraseStart));

    // wrap the phrase
    out += `<i>${escapeHtml(rawLine.slice(phraseStart, phraseEnd))}</i>`;

    last = phraseEnd;
  }

  // append remainder
  out += escapeHtml(rawLine.slice(last));

  return out;
}

function sbvToVtt(sbvText: string, italicsRe: RegExp | null) {
  const lines = sbvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let vtt = "WEBVTT\n\n";
  let i = 0;

  while (i < lines.length) {
    const timeLine = lines[i]?.trim();

    if (!timeLine) { i++; continue; }

    const tm = timeLine.match(/^(.+?),(.+?)$/);
    if (!tm) {
      i++;
      continue;
    }

    const start = normalizeHour(tm[1].trim());
    const end = normalizeHour(tm[2].trim());
    i++;

    const cueLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      cueLines.push(lines[i]);
      i++;
    }

    while (i < lines.length && lines[i].trim() === "") i++;

    const processed = cueLines
      .map(l => italicizeLineWholeWords(l, italicsRe))
      .join("\n");

    vtt += `${start} --> ${end}\n${processed}\n\n`;
  }

  return vtt.trimEnd() + "\n";
}

export async function onRequest(context: any): Promise<Response> {
  const { request } = context;

  if (request.method === "OPTIONS") return json({ ok: true }, 200);
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);

  let body: RequestBody;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const sbvText = typeof body.sbvText === "string" ? body.sbvText : "";
  if (!sbvText) return json({ error: "sbvText is required" }, 400);

  const italicsText = typeof body.italicsText === "string" ? body.italicsText : "";
  const phrases = buildItalicsList(italicsText);
  const italicsRe = buildItalicsRegex(phrases);

  const vtt = sbvToVtt(sbvText, italicsRe);
  return vttResponse(vtt, body.outputName || "captions.vtt");
}
