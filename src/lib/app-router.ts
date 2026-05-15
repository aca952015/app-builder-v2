import path from "node:path";

type RouteSegmentKind = "static" | "dynamic" | "catch-all" | "optional-catch-all";

const PAGE_ROUTE_GROUPS = [undefined, "(app)", "(admin)", "(full-width-pages)"] as const;

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

function routeToPageFilePath(segments: string[], group: typeof PAGE_ROUTE_GROUPS[number]): string {
  return group
    ? path.posix.join("app", group, ...segments, "page.tsx")
    : path.posix.join("app", ...segments, "page.tsx");
}

export function routeToPageFileCandidates(route: string): string[] {
  const normalizedSegments = normalizeRouteSegments(route);
  return PAGE_ROUTE_GROUPS.map((group) => routeToPageFilePath(normalizedSegments, group));
}

export function routeToAdminPagePath(route: string): string {
  const normalizedSegments = normalizeRouteSegments(route);
  return routeToPageFilePath(normalizedSegments, "(admin)");
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
