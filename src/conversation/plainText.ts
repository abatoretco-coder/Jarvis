const FORBIDDEN_BULLETS_RE = /[•◦▪▫●○■□◆◇]/g;
const MARKDOWN_TOKENS_RE = /[#*_`>|[\]()]/g;

export function toSingleParagraphPlainText(input: string): string {
  return String(input ?? '')
    .replace(FORBIDDEN_BULLETS_RE, ' ')
    .replace(MARKDOWN_TOKENS_RE, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
