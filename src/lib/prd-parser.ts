import { EntityDraft, ParsedPrd, ParsedSection } from "./types.js";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_PATTERN = /^\s*[-*+]\s+(.*)$/;
const NUMBERED_PATTERN =
  /^\s*(?:\d+(?:\.\d+)*[.)]?|[（(]?\d+[）)]|[一二三四五六七八九十]+[、.)]|[①②③④⑤⑥⑦⑧⑨⑩]|(?:\$?\\diamond\$?)|[◇◆▪•])\s*(.*)$/u;

function compactCjkSpacing(input: string): string {
  return input
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/\s+(?=[，。！？、；：])/gu, "")
    .trim();
}

function normalizeLine(line: string): string {
  return compactCjkSpacing(line.replace(/\s+/g, " ").trim());
}

function sluglessTitle(raw: string): string {
  return compactCjkSpacing(raw.replace(/^["'`]+|["'`]+$/g, "").trim());
}

function cleanHeadingLabel(raw: string): string {
  return sluglessTitle(raw)
    .replace(/^[（(]?\d+[）)]\s*/u, "")
    .replace(/^\d+(?:\.\d+)*[.)]?\s*/u, "")
    .replace(/^[一二三四五六七八九十]+[、.)]\s*/u, "")
    .trim();
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
    const headingKey = cleanHeadingLabel(section.heading).toLowerCase();
    const withinEntityArea = includesKeyword(section, /(entity|entities|data model|models|schema|实体|数据模型|模型|台账|设备|计量点|测点)/i);

    if (withinEntityArea && section.depth >= 3) {
      const lines = extractListItems(section.content);
      const key = headingKey;
      if (!seen.has(key)) {
        const draft: EntityDraft = {
          name: cleanHeadingLabel(section.heading),
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

function firstMatchingParagraph(sections: ParsedSection[], keywords: RegExp): string {
  for (const section of sections) {
    if (!keywords.test(cleanHeadingLabel(section.heading))) {
      continue;
    }
    const paragraph = firstParagraph(section.content);
    if (paragraph) {
      return paragraph;
    }
  }

  return "";
}

function extractFeatureHeadings(sections: ParsedSection[]): string[] {
  const seen = new Set<string>();
  const screens: string[] = [];

  for (const section of sections) {
    const cleanedHeading = cleanHeadingLabel(section.heading);
    if (!cleanedHeading) {
      continue;
    }

    const featureKeywords =
      /(screen|screens|page|pages|ui|interface|navigation|功能|模块|系统功能|信息架构|页面|监控|分析|计划|报警|告警|报表|设备|计量|管控)/i;
    const withinFeatureArea = featureKeywords.test(cleanedHeading) || includesKeyword(section, featureKeywords);
    const looksLikeConcreteFeature =
      section.depth >= 1 &&
      !/^(能源管理系统|项目概述|项目背景|建设理念|建设目标|系统架构|系统功能|overview|summary)$/i.test(cleanedHeading);

    if (!withinFeatureArea || !looksLikeConcreteFeature) {
      continue;
    }

    if (seen.has(cleanedHeading)) {
      continue;
    }
    seen.add(cleanedHeading);
    screens.push(cleanedHeading);
  }

  return screens;
}

export function parsePrd(markdown: string): ParsedPrd {
  const sections = parseSections(markdown);
  const title =
    cleanHeadingLabel(sections.find((section) => section.depth === 1)?.heading ?? "") ||
    cleanHeadingLabel(sections.find((section) => section.heading !== "Overview")?.heading ?? "") ||
    "Generated App";

  const summary =
    firstParagraph(sections.find((section) => section.path[0] === "Overview")?.content ?? "") ||
    firstMatchingParagraph(sections, /(summary|overview|introduction|项目概述|项目背景|建设理念|建设目标|背景)/i) ||
    `${title} generated from product requirements.`;

  const roles = sections
    .filter((section) => /^(user|users|role|roles|actor|actors|用户|角色|人员)$/i.test(cleanHeadingLabel(section.heading)))
    .flatMap((section) => extractListItems(section.content));

  const screens = [
    ...sections
      .filter((section) => includesKeyword(section, /(screen|screens|page|pages|ui|interface|navigation|页面|界面|导航)/i))
      .flatMap((section) => extractListItems(section.content)),
    ...extractFeatureHeadings(sections),
  ];

  const flows = sections
    .filter((section) => includesKeyword(section, /(flow|flows|journey|journeys|workflow|workflows|流程|业务流程|操作流程)/i))
    .flatMap((section) => extractListItems(section.content));

  const businessRules = sections
    .filter((section) => includesKeyword(section, /(rule|rules|constraint|constraints|acceptance|requirements|规则|约束|要求|规范)/i))
    .flatMap((section) => extractListItems(section.content));

  const openQuestions = sections
    .filter((section) => includesKeyword(section, /(question|questions|unknown|unknowns|open issue|open issues|待确认|待定|问题)/i))
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
