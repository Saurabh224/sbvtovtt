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
  // SBV can be "0:00:02.000" or "00:00:02.000"
  // Make it always HH:MM:SS.mmm
  // If it matches H:MM:SS.mmm → pad to 2-digit hour.
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

function buildItalicsList(italicsText: string): string[] {
  const lines = italicsText
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  // Sort longest first to avoid partial overlap issues
  lines.sort((a, b) => b.length - a.length);
  return lines;
}

function italicizeLine(line: string, phrases: string[]): string {
  if (!phrases.length) return escapeHtml(line);

  // Escape first; we’ll insert <i> tags into escaped content by mapping indices on the *original* string.
  // Simpler (and good enough for subtitles): do replacement on original, then escape non-tag parts.
  // Approach: build segments using regex with case-insensitive match, one phrase at a time.
  let out = line;

  for (const phrase of phrases) {
    // Escape regex special chars in phrase
    const escapedPhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escapedPhrase, "gi");

    // Avoid double-wrapping: don’t replace inside existing tags by checking a quick heuristic
    // (good enough here; subtitles rarely contain HTML to begin with)
    out = out.replace(re, (m) => `<i>${m}</i>`);
  }

  // Now escape everything except the <i> tags we inserted.
  // Convert to a safe form by temporarily protecting tags.
  const tokenI0 = "___I_OPEN___";
  const tokenI1 = "___I_CLOSE___";
  out = out.replace(/<i>/g, tokenI0).replace(/<\/i>/g, tokenI1);
  out = escapeHtml(out);
  out = out.replaceAll(tokenI0, "<i>").replaceAll(tokenI1, "</i>");

  return out;
}

function sbvToVtt(sbvText: string, italicsPhrases: string[]) {
  const lines = sbvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  let vtt = "WEBVTT\n\n";
  let i = 0;

  while (i < lines.length) {
    const timeLine = lines[i]?.trim();

    // skip empty lines
    if (!timeLine) { i++; continue; }

    // time line: "0:00:00.000,0:00:02.000"
    const tm = timeLine.match(/^(.+?),(.+?)$/);
    if (!tm) {
      // If malformed, just skip this line
      i++;
      continue;
    }

    const start = normalizeHour(tm[1].trim());
    const end = normalizeHour(tm[2].trim());
    i++;

    // collect text lines until blank line
    const cueLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      cueLines.push(lines[i]);
      i++;
    }

    // skip the blank separator
    while (i < lines.length && lines[i].trim() === "") i++;

    const processed = cueLines.map(l => italicizeLine(l, italicsPhrases)).join("\n");

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

  const vtt = sbvToVtt(sbvText, phrases);
  return vttResponse(vtt, body.outputName || "captions.vtt");
}
