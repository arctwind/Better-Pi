const MAX_TITLE_LENGTH = 24;
const MIN_TITLE_LENGTH = 3;
const GREETING = /^(?:你好|您好|hi|hello|hey)[，,。.!！\s]*/i;
const FILLER = /^(?:(?:请|帮我|帮忙|麻烦|能不能|可以|please|kindly|can you|could you|would you|help me)\s*)+/i;

export function autoSessionTitle(text) {
  if (typeof text !== "string" || text.trim().startsWith("/")) return;
  const normalized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|\s)@(?:"[^"]*"|[^\s]+)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  const firstLine = normalized.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const firstSentence = firstLine.match(/^.*?[。！？!?]/)?.[0] ?? firstLine;
  const cleaned = firstSentence
    .replace(/^[#>*+\-\s]+/, "")
    .replace(GREETING, "")
    .replace(FILLER, "")
    .replace(/[。！？!?，,；;：:、]+$/g, "")
    .trim();
  if ([...cleaned].length < MIN_TITLE_LENGTH) return;
  const chars = [...cleaned];
  return chars.length > MAX_TITLE_LENGTH ? `${chars.slice(0, MAX_TITLE_LENGTH).join("")}…` : cleaned;
}
