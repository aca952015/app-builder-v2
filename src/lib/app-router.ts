import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

type RouteSegmentKind = "static" | "dynamic" | "catch-all" | "optional-catch-all";

function normalizeRouteSegment(segment: string): string {
  if (
    /^\[\[\.\.\.[^/\]]+\]\]$/.test(segment) ||
    /^\[\.\.\.[^/\]]+\]$/.test(segment) ||
    /^\[[^/\]]+\]$/.test(segment)
  ) {
    return segment;
  }

  if (/^:[^/]+[?*]$/.test(segment)) {
    return `[[...${segment.slice(1, -1)}]]`;
  }

  if (/^:[^/]+\+$/.test(segment)) {
    return `[...${segment.slice(1, -1)}]`;
  }

  if (/^:[^/]+$/.test(segment)) {
    return `[${segment.slice(1)}]`;
  }

  if (/^\*[^/]+$/.test(segment)) {
    return `[...${segment.slice(1)}]`;
  }

  return segment;
}

export function normalizeRoutePath(route: string): string {
  const withoutQuery = route.split("?")[0] ?? route;
  const withLeadingSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  const trimmed = withLeadingSlash.replace(/\/+$/g, "");
  return trimmed === "" ? "/" : trimmed;
}

function splitRoutePath(route: string): string[] {
  const normalized = normalizeRoutePath(route);
  if (normalized === "/") {
    return [];
  }

  return normalized
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function normalizeRouteSegments(route: string): string[] {
  return splitRoutePath(route).map(normalizeRouteSegment);
}

export function normalizeRoutePattern(route: string): string {
  const segments = normalizeRouteSegments(route);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function routeToPageFilePath(segments: string[], group?: string): string {
  return group
    ? path.posix.join("app", group, ...segments, "page.tsx")
    : path.posix.join("app", ...segments, "page.tsx");
}

export function routeToAdminPagePath(route: string): string {
  const normalizedSegments = normalizeRouteSegments(route);
  return routeToPageFilePath(normalizedSegments, "(admin)");
}

function normalizeRelativeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/g, "");
}

function isRouteGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")") && segment.length > 2;
}

export function pageFilePathToRoutePattern(relativePath: string): string | null {
  const normalizedPath = normalizeRelativeFilePath(relativePath);
  const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const firstSegment = segments[0];
  const lastSegment = segments.at(-1);

  if (firstSegment !== "app" || lastSegment !== "page.tsx") {
    return null;
  }

  const routeSegments = segments
    .slice(1, -1)
    .filter((segment) => !isRouteGroupSegment(segment))
    .map(normalizeRouteSegment);

  return routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
}

export async function collectPageRoutePatterns(outputDirectory: string): Promise<Set<string>> {
  const appDirectory = path.join(outputDirectory, "app");
  const routePatterns = new Set<string>();

  async function visit(currentDirectory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      if (!entry.isFile() || entry.name !== "page.tsx") {
        continue;
      }

      const relativePath = path.relative(outputDirectory, absolutePath).split(path.sep).join("/");
      const routePattern = pageFilePathToRoutePattern(relativePath);
      if (routePattern) {
        routePatterns.add(routePattern);
      }
    }
  }

  await visit(appDirectory);
  return routePatterns;
}

function routeSegmentKind(segment: string): RouteSegmentKind {
  const normalized = normalizeRouteSegment(segment);
  if (/^\[\[\.\.\.[^/\]]+\]\]$/.test(normalized)) {
    return "optional-catch-all";
  }
  if (/^\[\.\.\.[^/\]]+\]$/.test(normalized)) {
    return "catch-all";
  }
  if (/^\[[^/\]]+\]$/.test(normalized)) {
    return "dynamic";
  }
  return "static";
}

function routeSegmentSpecificity(segment: string | undefined): number {
  if (segment === undefined) {
    return 4;
  }

  const kind = routeSegmentKind(segment);
  if (kind === "static") {
    return 3;
  }
  if (kind === "dynamic") {
    return 2;
  }
  if (kind === "catch-all") {
    return 1;
  }
  return 0;
}

function routePatternSegments(route: string): string[] {
  return normalizeRouteSegments(route);
}

function matchRouteSegments(pattern: string[], actual: string[]): boolean {
  if (pattern.length === 0) {
    return actual.length === 0;
  }

  const [patternHead, ...patternTail] = pattern;
  if (!patternHead) {
    return actual.length === 0;
  }

  const kind = routeSegmentKind(patternHead);
  if (kind === "optional-catch-all") {
    return true;
  }
  if (kind === "catch-all") {
    return actual.length > 0;
  }

  const [actualHead, ...actualTail] = actual;
  if (!actualHead) {
    return false;
  }

  if (kind === "dynamic") {
    return matchRouteSegments(patternTail, actualTail);
  }

  return patternHead === actualHead && matchRouteSegments(patternTail, actualTail);
}

export function routePatternMatchesPath(pattern: string, actualPath: string): boolean {
  return matchRouteSegments(routePatternSegments(pattern), splitRoutePath(actualPath));
}

export function compareRoutePatternsBySpecificity(left: string, right: string): number {
  const leftSegments = routePatternSegments(left);
  const rightSegments = routePatternSegments(right);
  const maxLength = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftScore = routeSegmentSpecificity(leftSegments[index]);
    const rightScore = routeSegmentSpecificity(rightSegments[index]);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
  }

  return 0;
}

export function hasDynamicRoutePattern(route: string): boolean {
  return routePatternSegments(route).some((segment) => routeSegmentKind(segment) !== "static");
}

function sampleDynamicRouteSegment(segment: string): string[] {
  const kind = routeSegmentKind(segment);
  if (kind === "catch-all" || kind === "optional-catch-all") {
    return ["sample", "path"];
  }

  const normalized = normalizeRouteSegment(segment)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  if (/(^|_|\b)(id|key|index|number)(_|$|\b)/.test(normalized)) {
    return ["1"];
  }
  return ["sample"];
}

export function routePatternToSamplePath(route: string): string {
  const sampledSegments = routePatternSegments(route).flatMap((segment) => (
    routeSegmentKind(segment) === "static" ? [segment] : sampleDynamicRouteSegment(segment)
  ));
  return sampledSegments.length === 0 ? "/" : `/${sampledSegments.join("/")}`;
}
