import { AppEntity, AppScreen, EntityField, FieldType, NormalizedSpec, ParsedPrd } from "./types.js";

function compactCjkSpacing(input: string): string {
  return input
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, "$1")
    .replace(/\s+(?=[，。！？、；：])/gu, "")
    .trim();
}

function titleCase(input: string): string {
  const normalized = compactCjkSpacing(input);
  if (/[^\x00-\x7F]/.test(normalized)) {
    return normalized;
  }

  return normalized
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slugify(input: string): string {
  const slug = compactCjkSpacing(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .replace(/-{2,}/g, "-");

  return slug;
}

function toIdentifier(input: string): string {
  const compact = input
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();

  const [first = "field", ...rest] = compact.split(/\s+/);
  return [first.toLowerCase(), ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())].join("");
}

function pluralize(name: string): string {
  if (name.endsWith("s")) {
    return `${name}es`;
  }
  if (name.endsWith("y")) {
    return `${name.slice(0, -1)}ies`;
  }
  return `${name}s`;
}

function inferType(token: string): FieldType {
  const lower = token.toLowerCase();

  if (lower.includes("date") || lower.includes("deadline")) {
    return "date";
  }
  if (lower.includes("time") || lower.includes("timestamp")) {
    return "datetime";
  }
  if (lower.includes("email")) {
    return "email";
  }
  if (lower.includes("count") || lower.includes("number") || lower.includes("amount") || lower.includes("price")) {
    return "number";
  }
  if (lower.startsWith("is ") || lower.startsWith("has ") || lower.includes("enabled") || lower.includes("active")) {
    return "boolean";
  }
  if (lower.includes("description") || lower.includes("notes") || lower.includes("summary")) {
    return "text";
  }

  return "string";
}

function parseFieldToken(token: string): EntityField | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const typeMatch = trimmed.match(/^(.+?)(?:\s*\(([^)]+)\)|\s*:\s*([a-zA-Z]+))$/);
  const rawName = typeMatch?.[1] ?? trimmed;
  const explicitType = typeMatch?.[2] ?? typeMatch?.[3] ?? "";
  const normalizedName = toIdentifier(rawName.replace(/\boptional\b/i, "").trim());
  const required = !/\boptional\b/i.test(trimmed);
  const hintedType = explicitType ? inferType(explicitType) : inferType(trimmed);

  return {
    name: normalizedName,
    label: titleCase(rawName.replace(/\boptional\b/i, "").trim()),
    type: hintedType,
    required,
  };
}

function ensureTitleField(fields: EntityField[], defaultsApplied: string[], entityName: string): EntityField[] {
  if (fields.some((field) => field.name === "title" || field.name === "name")) {
    return fields;
  }

  defaultsApplied.push(`Added title field to ${entityName} because the PRD did not define a primary label.`);
  return [
    {
      name: "title",
      label: "Title",
      type: "string",
      required: true,
    },
    ...fields,
  ];
}

function isGeneratedSummary(summary: string): boolean {
  return /generated from product requirements\.$/.test(summary);
}

function hasMeaningfulStructure(parsed: ParsedPrd): boolean {
  return parsed.screens.length > 0 || !isGeneratedSummary(parsed.summary);
}

function buildCrudScreens(entities: AppEntity[]): AppScreen[] {
  const screens: AppScreen[] = [
    { name: "Dashboard", route: "/", purpose: "Overview of core metrics and recent records." },
    { name: "Login", route: "/login", purpose: "Email and password sign-in." },
    { name: "Settings", route: "/settings", purpose: "Basic profile and environment details." },
  ];

  for (const entity of entities) {
    screens.push({
      name: `${entity.pluralName} List`,
      route: `/${entity.routeSegment}`,
      purpose: `Browse and search ${entity.pluralName.toLowerCase()}.`,
    });
    screens.push({
      name: `Create ${entity.name}`,
      route: `/${entity.routeSegment}/new`,
      purpose: `Create a new ${entity.name.toLowerCase()}.`,
    });
    screens.push({
      name: `${entity.name} Detail`,
      route: `/${entity.routeSegment}/[id]`,
      purpose: `Review and update one ${entity.name.toLowerCase()}.`,
    });
  }

  return screens;
}

function buildScreenRouteToken(name: string, index: number): string {
  const normalized = titleCase(name);
  const routeRules: Array<[RegExp, string]> = [
    [/(dashboard|overview|home|首页|总览|概览)/i, ""],
    [/(login|sign in|登录)/i, "login"],
    [/(setting|settings|配置|设置)/i, "settings"],
    [/(analysis|analytics|分析)/i, "analysis"],
    [/(report|reports|统计|报表)/i, "reports"],
    [/(plan|planning|计划)/i, "planning"],
    [/(alarm|alert|报警|告警)/i, "alerts"],
    [/(monitor|monitoring|监控)/i, "monitoring"],
    [/(manage|management|管理)/i, "management"],
  ];

  for (const [pattern, token] of routeRules) {
    if (pattern.test(normalized)) {
      return token;
    }
  }

  const slug = slugify(normalized);
  if (slug) {
    return slug;
  }

  return `module-${index + 1}`;
}

function buildPrdScreens(screenNames: string[]): AppScreen[] {
  const screens: AppScreen[] = [];
  const seenNames = new Set<string>();
  const seenRoutes = new Set<string>();

  const pushScreen = (name: string, desiredRoute: string | null, purpose: string) => {
    const normalizedName = titleCase(name);
    if (!normalizedName || seenNames.has(normalizedName)) {
      return;
    }

    let route = desiredRoute ?? "/";
    if (seenRoutes.has(route)) {
      let suffix = 2;
      while (seenRoutes.has(`${route}-${suffix}`)) {
        suffix += 1;
      }
      route = `${route}-${suffix}`;
    }

    screens.push({ name: normalizedName, route, purpose });
    seenNames.add(normalizedName);
    seenRoutes.add(route);
  };

  pushScreen("Dashboard", "/", "Overview of PRD-derived modules and recent system activity.");

  screenNames.forEach((screenName, index) => {
    const token = buildScreenRouteToken(screenName, index);
    const route = token ? `/${token}` : "/";
    pushScreen(screenName, route, `PRD-derived module for ${titleCase(screenName)}.`);
  });

  if (!seenNames.has("Settings")) {
    pushScreen("Settings", "/settings", "Basic profile, permissions, and configuration settings.");
  }

  return screens;
}

function buildScreenBasedFlows(screens: AppScreen[]): string[] {
  const meaningfulScreens = screens
    .map((screen) => screen.name)
    .filter((name) => !/^(Dashboard|Login|Settings)$/i.test(name))
    .slice(0, 3);

  if (meaningfulScreens.length === 0) {
    return [];
  }

  const flows = [`User reviews Dashboard to understand the current system state.`];
  if (meaningfulScreens[0]) {
    flows.push(`User opens ${meaningfulScreens[0]} to work on one core module defined in the PRD.`);
  }
  if (meaningfulScreens[1]) {
    flows.push(`User switches to ${meaningfulScreens[1]} to continue a related workflow.`);
  }
  if (meaningfulScreens[2]) {
    flows.push(`User uses ${meaningfulScreens[2]} when deeper analysis or follow-up actions are needed.`);
  }

  return flows;
}

export function normalizeSpec(parsed: ParsedPrd, sourceMarkdown: string, appNameOverride?: string): NormalizedSpec {
  const warnings: string[] = [];
  const defaultsApplied: string[] = [];
  const structuredPrd = hasMeaningfulStructure(parsed);

  const entities = parsed.entities
    .map((draft): AppEntity | null => {
      const sanitizedName = titleCase(draft.name);
      if (!sanitizedName) {
        return null;
      }

      const fields = ensureTitleField(
        draft.fields.map(parseFieldToken).filter((field): field is EntityField => field !== null),
        defaultsApplied,
        sanitizedName,
      );

      if (fields.length === 0) {
        warnings.push(`Skipped entity "${draft.name}" because no usable fields could be derived.`);
        return null;
      }

      return {
        name: sanitizedName,
        pluralName: titleCase(pluralize(sanitizedName)),
        routeSegment: slugify(pluralize(sanitizedName)) || `records-${draft.name.length}`,
        description: draft.description || `${sanitizedName} records derived from the PRD.`,
        fields,
      };
    })
    .filter((entity): entity is AppEntity => entity !== null);

  if (entities.length === 0 && !structuredPrd) {
    defaultsApplied.push("No entities were detected, so a default Item entity was created.");
    entities.push({
      name: "Item",
      pluralName: "Items",
      routeSegment: "items",
      description: "Fallback entity created because the PRD did not define a data model.",
      fields: [
        { name: "title", label: "Title", type: "string", required: true },
        { name: "status", label: "Status", type: "string", required: true },
        { name: "notes", label: "Notes", type: "text", required: false },
      ],
    });
  } else if (entities.length === 0) {
    warnings.push("No structured data model was detected in the PRD; entity design is deferred to the planning stage.");
  }

  const roles = Array.from(new Set(parsed.roles.map(titleCase).filter(Boolean)));
  if (roles.length === 0 && !structuredPrd) {
    defaultsApplied.push("No roles were identified, so a default Member role was added.");
    roles.push("Member");
  } else if (roles.length === 0) {
    warnings.push("No explicit roles were identified in the PRD; role design is deferred to the planning stage.");
  }

  const screens = entities.length > 0
    ? buildCrudScreens(entities)
    : parsed.screens.length > 0
      ? buildPrdScreens(parsed.screens)
      : buildCrudScreens(entities);

  const inferredFlows = parsed.flows.length === 0 ? buildScreenBasedFlows(screens) : [];
  const flows =
    parsed.flows.length > 0
      ? parsed.flows
      : inferredFlows.length > 0
        ? inferredFlows
        : [
            "User signs in with email and password.",
            `User reviews the dashboard and navigates to ${entities[0]!.pluralName.toLowerCase()}.`,
            `User creates, edits, and deletes ${entities[0]!.pluralName.toLowerCase()}.`,
          ];
  if (parsed.flows.length === 0 && inferredFlows.length === 0 && entities.length > 0) {
    defaultsApplied.push("No user flows were listed, so a default sign-in and CRUD flow was generated.");
  } else if (parsed.flows.length === 0 && inferredFlows.length === 0) {
    warnings.push("No explicit user flows were identified in the PRD.");
  }

  const businessRules =
    parsed.businessRules.length > 0
      ? parsed.businessRules
      : entities.length > 0
        ? [
            "Authenticated users can manage the generated business records.",
            "All records track creation and update timestamps.",
          ]
        : [];
  if (parsed.businessRules.length === 0 && entities.length > 0) {
    defaultsApplied.push("No business rules were listed, so baseline CRUD rules were added.");
  } else if (parsed.businessRules.length === 0) {
    warnings.push("No explicit business rules were identified in the PRD.");
  }

  if (parsed.openQuestions.length > 0) {
    warnings.push(...parsed.openQuestions.map((question) => `Open question preserved from PRD: ${question}`));
  }

  return {
    appName: appNameOverride || titleCase(parsed.title),
    slug: slugify(appNameOverride || parsed.title) || "app",
    summary: parsed.summary,
    roles,
    entities,
    screens,
    flows,
    businessRules,
    warnings,
    defaultsApplied,
    sourceMarkdown,
  };
}
