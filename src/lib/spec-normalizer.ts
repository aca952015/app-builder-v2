import { AppEntity, AppScreen, EntityField, FieldType, NormalizedSpec, ParsedPrd } from "./types.js";

function titleCase(input: string): string {
  return input
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .replace(/-{2,}/g, "-");
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

function buildScreens(entities: AppEntity[]): AppScreen[] {
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

export function normalizeSpec(parsed: ParsedPrd, sourceMarkdown: string, appNameOverride?: string): NormalizedSpec {
  const warnings: string[] = [];
  const defaultsApplied: string[] = [];

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
        routeSegment: slugify(pluralize(sanitizedName)),
        description: draft.description || `${sanitizedName} records derived from the PRD.`,
        fields,
      };
    })
    .filter((entity): entity is AppEntity => entity !== null);

  if (entities.length === 0) {
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
  }

  const roles = Array.from(new Set(parsed.roles.map(titleCase).filter(Boolean)));
  if (roles.length === 0) {
    defaultsApplied.push("No roles were identified, so a default Member role was added.");
    roles.push("Member");
  }

  const flows = parsed.flows.length > 0
    ? parsed.flows
    : [
        "User signs in with email and password.",
        `User reviews the dashboard and navigates to ${entities[0]!.pluralName.toLowerCase()}.`,
        `User creates, edits, and deletes ${entities[0]!.pluralName.toLowerCase()}.`,
      ];
  if (parsed.flows.length === 0) {
    defaultsApplied.push("No user flows were listed, so a default sign-in and CRUD flow was generated.");
  }

  const businessRules = parsed.businessRules.length > 0
    ? parsed.businessRules
    : [
        "Authenticated users can manage the generated business records.",
        "All records track creation and update timestamps.",
      ];
  if (parsed.businessRules.length === 0) {
    defaultsApplied.push("No business rules were listed, so baseline CRUD rules were added.");
  }

  if (parsed.openQuestions.length > 0) {
    warnings.push(...parsed.openQuestions.map((question) => `Open question preserved from PRD: ${question}`));
  }

  return {
    appName: appNameOverride || titleCase(parsed.title),
    slug: slugify(appNameOverride || parsed.title),
    summary: parsed.summary,
    roles,
    entities,
    screens: buildScreens(entities),
    flows,
    businessRules,
    warnings,
    defaultsApplied,
    sourceMarkdown,
  };
}
