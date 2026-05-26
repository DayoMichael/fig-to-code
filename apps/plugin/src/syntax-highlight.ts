/** Lightweight TS/TSX highlighter for the plugin code preview (Cursor-inspired palette). */

const KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "null",
  "return",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function span(className: string, value: string): string {
  return `<span class="tok-${className}">${escapeHtml(value)}</span>`;
}

function highlightLine(line: string): string {
  let result = "";
  let index = 0;

  while (index < line.length) {
    const rest = line.slice(index);

    const commentMatch = rest.match(/^\/\/.*$/);
    if (commentMatch) {
      result += span("comment", commentMatch[0]);
      break;
    }

    const blockCommentMatch = rest.match(/^\/\*[\s\S]*?\*\//);
    if (blockCommentMatch) {
      result += span("comment", blockCommentMatch[0]);
      index += blockCommentMatch[0].length;
      continue;
    }

    const stringMatch = rest.match(/^(`(?:\\[\s\S]|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/);
    if (stringMatch) {
      result += span("string", stringMatch[0]);
      index += stringMatch[0].length;
      continue;
    }

    const jsxTagMatch = rest.match(/^<\/?[A-Za-z][\w.-]*/);
    if (jsxTagMatch) {
      result += span("tag", jsxTagMatch[0]);
      index += jsxTagMatch[0].length;
      continue;
    }

    const wordMatch = rest.match(/^[A-Za-z_$][\w$]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      if (KEYWORDS.has(word)) {
        result += span("keyword", word);
      } else if (/^[A-Z]/.test(word)) {
        result += span("type", word);
      } else if (index > 0 && line[index - 1] === ".") {
        result += span("property", word);
      } else {
        result += span("plain", word);
      }
      index += word.length;
      continue;
    }

    const numberMatch = rest.match(/^\d+(?:\.\d+)?/);
    if (numberMatch) {
      result += span("number", numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }

    if (/^[{}()[\];:,<>]/.test(rest)) {
      result += span("punctuation", rest[0]!);
      index += 1;
      continue;
    }

    result += span("plain", rest[0]!);
    index += 1;
  }

  return result;
}

export function highlightTs(source: string): string {
  if (!source.trim()) {
    return "";
  }

  return source
    .split("\n")
    .map((line) => highlightLine(line))
    .join("\n");
}

export function renderLineNumbers(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
}
