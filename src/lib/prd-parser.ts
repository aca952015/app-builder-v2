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
  return compactCjkSpacing(
    raw
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~`]+/g, "")
      .replace(/^["'`“”‘’]+|["'`“”‘’]+$/gu, "")
      .trim(),
  );
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

function trimDocumentTitleSuffix(raw: string): string {
  return raw
    .replace(/\s*(?:用户手册|使用手册|操作手册|产品手册|需求文档|产品需求文档|需求规格说明书|说明书|PRD)\s*$/iu, "")
    .trim();
}

function isLowValueTitleCandidate(raw: string): boolean {
  const title = cleanHeadingLabel(raw).toLowerCase();
  return /^(目录|table of contents|toc|用户手册|使用手册|操作手册|产品手册|编写目的|适用范围|术语|修订记录|版本记录|系统中流程图|业务流程图|项目概述|项目背景|overview|summary|introduction)$/.test(title);
}

function cleanDocumentTitleCandidate(raw: string): string {
  return trimDocumentTitleSuffix(cleanHeadingLabel(raw.replace(/^[-*+]\s+/, "")));
}

function looksLikeDocumentTitle(raw: string): boolean {
  const title = cleanDocumentTitleCandidate(raw);
  if (!title || title.length < 2 || title.length > 80 || isLowValueTitleCandidate(title)) {
    return false;
  }

  if (/^[|:-]+$/.test(title) || /[。！？；;]$/.test(title)) {
    return false;
  }

  return /(系统|平台|应用|管理|中心|门户|LIMS|CRM|ERP|MES|WMS|SaaS|Console|Dashboard)/i.test(title);
}

function extractDocumentTitle(sections: ParsedSection[]): string {
  const overview = sections.find((section) => section.path[0] === "Overview");
  if (!overview) {
    return "";
  }

  for (const line of overview.content.split(/\r?\n/).slice(0, 80)) {
    const normalized = normalizeLine(line);
    if (
      !normalized ||
      BULLET_PATTERN.test(normalized) ||
      NUMBERED_PATTERN.test(normalized) ||
      /^\|.*\|$/.test(normalized) ||
      isLowValueTitleCandidate(normalized)
    ) {
      continue;
    }

    if (looksLikeDocumentTitle(normalized)) {
      return cleanDocumentTitleCandidate(normalized);
    }
  }

  const boldCandidates = overview.content.matchAll(/\*\*([^*\n]{2,80})\*\*/gu);
  for (const match of boldCandidates) {
    const candidate = match[1] ?? "";
    if (looksLikeDocumentTitle(candidate)) {
      return cleanDocumentTitleCandidate(candidate);
    }
  }

  return "";
}

function isDocumentStructureHeading(raw: string): boolean {
  const heading = cleanHeadingLabel(raw);
  if (!heading) {
    return true;
  }

  const normalized = heading.toLowerCase();
  if (
    /^(功能需求(?:列表)?|非功能性?需求|核心目标|技术栈建议|环境配置|开发优先级说明|项目概述|项目背景|用户流程|业务流程|api 参考|api参考)$/iu
      .test(normalized)
  ) {
    return true;
  }

  if (
    /(?:需求|要求|说明|配置|原则)$/u.test(heading) &&
    !/(页面|界面|导航|看板|管理|监控|报表|报警|告警|管控|计划)/u.test(heading)
  ) {
    return true;
  }

  return false;
}

function extractFeatureHeadings(sections: ParsedSection[]): string[] {
  const seen = new Set<string>();
  const screens: string[] = [];

  for (const section of sections) {
    const cleanedHeading = cleanHeadingLabel(section.heading);
    if (!cleanedHeading || isDocumentStructureHeading(cleanedHeading)) {
      continue;
    }

    const featureKeywords =
      /(screen|screens|page|pages|ui|interface|navigation|module|modules|信息架构|页面|界面|导航|看板|管理|监控|分析|计划|报警|告警|报表|设备|计量|管控)/i;
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
  const firstPrimaryHeadingTitle = cleanHeadingLabel(sections.find((section) => section.depth === 1)?.heading ?? "");
  const primaryHeadingTitle = isLowValueTitleCandidate(firstPrimaryHeadingTitle) ? "" : firstPrimaryHeadingTitle;
  const documentTitle = extractDocumentTitle(sections);
  const firstMeaningfulSectionTitle = cleanHeadingLabel(
    sections.find((section) => section.heading !== "Overview" && !isLowValueTitleCandidate(section.heading))?.heading ?? "",
  );
  const firstSectionTitle = cleanHeadingLabel(sections.find((section) => section.heading !== "Overview")?.heading ?? "");
  const title =
    primaryHeadingTitle ||
    documentTitle ||
    firstMeaningfulSectionTitle ||
    firstPrimaryHeadingTitle ||
    firstSectionTitle ||
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
      .flatMap((section) => extractListItems(section.content))
      .filter((screen) => !isDocumentStructureHeading(screen)),
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
