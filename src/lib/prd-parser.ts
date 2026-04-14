import { EntityDraft, ParsedPrd, ParsedSection } from "./types.js";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_PATTERN = /^\s*[-*+]\s+(.*)$/;
const NUMBERED_PATTERN = /^\s*\d+\.\s+(.*)$/;

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function sluglessTitle(raw: string): string {
  return raw.replace(/^["'`]+|["'`]+$/g, "").trim();
}

function parseSections(markdown: string): ParsedSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: ParsedSection[] = [];
  const stack: Array<{ depth: number; heading: string }> = [];
  let current: ParsedSection | null = null;

  for (const line of lines) {
    const headingMatch = line.match(HEADING_PATTERN);
    if (headingMatch) {
      const hashes = headingMatch[1];
      const rawHeading = headingMatch[2];
      if (!hashes || !rawHeading) {
        continue;
      }
      if (current) {
        current.content = current.content.trim();
        sections.push(current);
      }

      const depth = hashes.length;
      const heading = sluglessTitle(rawHeading);

      while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
        stack.pop();
      }

      stack.push({ depth, heading });
      current = {
        heading,
        depth,
        path: stack.map((item) => item.heading),
        content: "",
      };
      continue;
    }

    if (!current) {
      current = {
        heading: "Overview",
        depth: 0,
        path: ["Overview"],
        content: "",
      };
    }

    current.content += `${line}\n`;
  }

  if (current) {
    current.content = current.content.trim();
    sections.push(current);
  }

  return sections.filter((section) => section.heading || section.content);
}

function extractListItems(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => {
      const bulletMatch = line.match(BULLET_PATTERN);
      const numberedMatch = line.match(NUMBERED_PATTERN);
      return bulletMatch?.[1] ?? numberedMatch?.[1] ?? "";
    })
    .map(normalizeLine)
    .filter(Boolean);
}

function firstNarrativeLine(content: string): string | undefined {
  return content
    .split(/\r?\n/)
    .map(normalizeLine)
    .find((line) => line && !BULLET_PATTERN.test(line) && !NUMBERED_PATTERN.test(line));
}

function includesKeyword(section: ParsedSection, keywords: RegExp): boolean {
  return section.path.some((part) => keywords.test(part.toLowerCase()));
}

function parseEntityListItem(item: string): EntityDraft | null {
  const [head, ...rest] = item.split(":");
  if (!head) {
    return null;
  }

  const name = normalizeLine(head);
  if (!name) {
    return null;
  }

  const fieldChunk = rest.join(":");
  const fields = fieldChunk
    .split(",")
    .map(normalizeLine)
    .filter(Boolean);

  return {
    name,
    fields,
  };
}

function extractEntityDrafts(sections: ParsedSection[]): EntityDraft[] {
  const drafts: EntityDraft[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    const headingKey = section.heading.toLowerCase();
    const withinEntityArea = includesKeyword(section, /(entity|entities|data model|models|schema)/);

    if (withinEntityArea && section.depth >= 3) {
      const lines = extractListItems(section.content);
      const key = headingKey;
      if (!seen.has(key)) {
        const draft: EntityDraft = {
          name: section.heading,
          fields: lines,
        };
        const maybeDescription = firstNarrativeLine(section.content);
        if (maybeDescription) {
          draft.description = maybeDescription;
        }
        drafts.push(draft);
        seen.add(key);
      }
      continue;
    }

    if (!withinEntityArea) {
      continue;
    }

    for (const item of extractListItems(section.content)) {
      const draft = parseEntityListItem(item);
      if (!draft) {
        continue;
      }
      const key = draft.name.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      drafts.push(draft);
      seen.add(key);
    }
  }

  return drafts;
}

function firstParagraph(content: string): string {
  return content
    .split(/\n\s*\n/)
    .map(normalizeLine)
    .find(Boolean) ?? "";
}

export function parsePrd(markdown: string): ParsedPrd {
  const sections = parseSections(markdown);
  const title =
    sections.find((section) => section.depth === 1)?.heading ??
    sections.find((section) => section.heading !== "Overview")?.heading ??
    "Generated App";

  const summary =
    firstParagraph(sections.find((section) => section.path[0] === "Overview")?.content ?? "") ||
    firstParagraph(sections.find((section) => section.heading.toLowerCase().includes("summary"))?.content ?? "") ||
    `${title} generated from product requirements.`;

  const roles = sections
    .filter((section) => /^(user|users|role|roles|actor|actors)$/i.test(section.heading))
    .flatMap((section) => extractListItems(section.content));

  const screens = sections
    .filter((section) => includesKeyword(section, /(screen|screens|page|pages|ui|interface|navigation)/))
    .flatMap((section) => extractListItems(section.content));

  const flows = sections
    .filter((section) => includesKeyword(section, /(flow|flows|journey|journeys|workflow|workflows)/))
    .flatMap((section) => extractListItems(section.content));

  const businessRules = sections
    .filter((section) => includesKeyword(section, /(rule|rules|constraint|constraints|acceptance|requirements)/))
    .flatMap((section) => extractListItems(section.content));

  const openQuestions = sections
    .filter((section) => includesKeyword(section, /(question|questions|unknown|unknowns|open issue|open issues)/))
    .flatMap((section) => extractListItems(section.content));

  return {
    title,
    summary,
    sections,
    entities: extractEntityDrafts(sections),
    roles,
    screens,
    flows,
    businessRules,
    openQuestions,
  };
}
