/** YAML frontmatter splitting for Markdown-defined plugin contributions. */
import { parse as parseYaml } from "yaml";

const FRONTMATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The parsed frontmatter mapping plus the Markdown body after the closing `---`. */
export interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly error?: string;
}

/** Malformed YAML falls back to top-level fields for compatibility with imported skills. */
export function splitFrontmatter(markdown: string): Frontmatter {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { data: {}, body: markdown };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1]!) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch (error) {
    return {
      data: parseTopLevelFields(match[1]!),
      body: markdown.slice(match[0].length),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { data, body: markdown.slice(match[0].length) };
}

function parseTopLevelFields(yaml: string): Record<string, unknown> {
  return Object.fromEntries(yaml.split(/(?=^[A-Za-z_][\w-]*:)/m).flatMap((block) => {
    const field = /^([A-Za-z_][\w-]*):(?:[ \t]+([^\r\n]*)|(?=\r?\n|$))/.exec(block);
    if (!field) return [];
    try {
      return Object.entries(parseYaml(block) as Record<string, unknown>);
    } catch {
      const value = field[2]?.trim();
      return value && !/^[[\]{},&*!|>'"%@`]/.test(value) ? [[field[1]!, value]] : [];
    }
  }));
}

/** Parsed frontmatter keys only; security checks depend on key presence. */
export function parseFrontmatter(markdown: string): Record<string, unknown> {
  return splitFrontmatter(markdown).data;
}
