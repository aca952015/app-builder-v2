import path from "node:path";

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

function normalizeRouteSegments(route: string): string[] {
  const cleanRoute = route.replace(/^\/+|\/+$/g, "");
  if (!cleanRoute) {
    return [];
  }

  return cleanRoute
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(normalizeRouteSegment);
}

export function routeToPageFileCandidates(route: string): string[] {
  const normalizedSegments = normalizeRouteSegments(route);
  if (normalizedSegments.length === 0) {
    return [
      "app/page.tsx",
      "app/(admin)/page.tsx",
      "app/(full-width-pages)/page.tsx",
    ];
  }

  return [
    path.posix.join("app", ...normalizedSegments, "page.tsx"),
    path.posix.join("app", "(admin)", ...normalizedSegments, "page.tsx"),
    path.posix.join("app", "(full-width-pages)", ...normalizedSegments, "page.tsx"),
  ];
}

export function routeToAdminPagePath(route: string): string {
  const normalizedSegments = normalizeRouteSegments(route);
  return normalizedSegments.length > 0
    ? path.posix.join("app", "(admin)", ...normalizedSegments, "page.tsx")
    : path.posix.join("app", "(admin)", "page.tsx");
}
