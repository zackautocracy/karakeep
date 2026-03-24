/**
 * Parse WebVTT subtitle content into simple HTML paragraphs.
 * Strips timestamps, deduplicates repeated lines (common in auto-generated subs),
 * and wraps in <p> tags.
 */
export function parseVttToHtml(vttContent: string): string | null {
  const lines = vttContent.split("\n");
  const textLines: string[] = [];
  let lastLine = "";

  const timestampRegex = /\d{2}:\d{2}.*-->/;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip WEBVTT header, empty lines, timestamp lines, and cue identifiers (pure numbers)
    if (
      line === "WEBVTT" ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line === "" ||
      timestampRegex.test(line) ||
      /^\d+$/.test(line)
    ) {
      continue;
    }

    // Strip inline HTML tags (VTT allows <b>, <i>, <u>, etc.)
    const cleaned = line.replace(/<[^>]+>/g, "").trim();
    if (!cleaned) continue;

    // Deduplicate consecutive identical lines
    if (cleaned === lastLine) continue;
    lastLine = cleaned;

    textLines.push(cleaned);
  }

  if (textLines.length === 0) return null;

  // Group into paragraphs (~5 lines per paragraph for readability)
  const paragraphs: string[] = [];
  for (let i = 0; i < textLines.length; i += 5) {
    const chunk = textLines.slice(i, i + 5).join(" ");
    paragraphs.push(`<p>${chunk}</p>`);
  }

  return paragraphs.join("\n");
}
