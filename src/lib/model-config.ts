export const DEFAULT_MODEL_NAME = "openai:gpt-4.1-mini";

export const GLOBAL_API_KEY_ENV = "APP_BUILDER_API_KEY";

export const GLOBAL_BASE_URL_ENV = "APP_BUILDER_BASE_URL";

export const MODEL_ROLES = ["plan", "generate", "repair"] as const;

export type ModelRole = typeof MODEL_ROLES[number];

export type ModelRoleConfig = {
  role: ModelRole;
  modelName: string;
  baseURL?: string;
  apiKey?: string;
};

export type SanitizedModelRoleConfig = Omit<ModelRoleConfig, "apiKey">;

export type ModelRoleConfigMap = Record<ModelRole, ModelRoleConfig>;

export type SanitizedModelRoleConfigMap = Record<ModelRole, SanitizedModelRoleConfig>;

type EnvSource = Record<string, string | undefined>;

type ResolveModelRoleConfigOptions = {
  persisted?: Partial<SanitizedModelRoleConfigMap>;
  fallbackModelName?: string | undefined;
  requireApiKeys?: boolean;
};

function trimOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readEnvValue(env: EnvSource, key: string): string | undefined {
  return trimOptional(env[key]);
}

function roleEnvPrefix(role: ModelRole): string {
  return `APP_BUILDER_${role.toUpperCase()}`;
}

function roleApiKeyEnvName(role: ModelRole): string {
  return `${roleEnvPrefix(role)}_API_KEY`;
}

function buildModelRoleConfig(
  role: ModelRole,
  env: EnvSource,
  options: ResolveModelRoleConfigOptions,
): ModelRoleConfig {
  const persisted = options.persisted?.[role];
  const modelName =
    readEnvValue(env, `${roleEnvPrefix(role)}_MODEL`) ??
    readEnvValue(env, "APP_BUILDER_MODEL") ??
    trimOptional(persisted?.modelName) ??
    trimOptional(options.fallbackModelName) ??
    DEFAULT_MODEL_NAME;
  const baseURL =
    readEnvValue(env, `${roleEnvPrefix(role)}_BASE_URL`) ??
    readEnvValue(env, GLOBAL_BASE_URL_ENV) ??
    trimOptional(persisted?.baseURL);
  const apiKey = readEnvValue(env, roleApiKeyEnvName(role)) ?? readEnvValue(env, GLOBAL_API_KEY_ENV);
  const config: ModelRoleConfig = {
    role,
    modelName,
  };

  if (baseURL) {
    config.baseURL = baseURL;
  }

  if (apiKey) {
    config.apiKey = apiKey;
  }

  return config;
}

export function validateModelRoleApiKeys(configs: ModelRoleConfigMap): void {
  const missingRoles = MODEL_ROLES.filter((role) => !configs[role].apiKey);
  if (missingRoles.length === 0) {
    return;
  }

  const missingRoleKeys = missingRoles.map(roleApiKeyEnvName).join(", ");
  throw new Error(
    `${GLOBAL_API_KEY_ENV} or role-specific API keys are required for plan, generate, and repair model roles. Missing: ${missingRoleKeys}.`,
  );
}

export function resolveModelRoleConfigs(
  env: EnvSource = process.env,
  options: ResolveModelRoleConfigOptions = {},
): ModelRoleConfigMap {
  const configs = {
    plan: buildModelRoleConfig("plan", env, options),
    generate: buildModelRoleConfig("generate", env, options),
    repair: buildModelRoleConfig("repair", env, options),
  } satisfies ModelRoleConfigMap;

  if (options.requireApiKeys !== false) {
    validateModelRoleApiKeys(configs);
  }

  return configs;
}

export function sanitizeModelRoleConfigs(configs: ModelRoleConfigMap): SanitizedModelRoleConfigMap {
  return {
    plan: sanitizeModelRoleConfig(configs.plan),
    generate: sanitizeModelRoleConfig(configs.generate),
    repair: sanitizeModelRoleConfig(configs.repair),
  };
}

function sanitizeModelRoleConfig(config: ModelRoleConfig): SanitizedModelRoleConfig {
  const sanitized: SanitizedModelRoleConfig = {
    role: config.role,
    modelName: config.modelName,
  };

  if (config.baseURL) {
    sanitized.baseURL = config.baseURL;
  }

  return sanitized;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = trimOptional(record[key]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function parseSanitizedModelRoleConfigs(value: unknown): Partial<SanitizedModelRoleConfigMap> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record = value as Record<string, unknown>;
  const result: Partial<SanitizedModelRoleConfigMap> = {};

  for (const role of MODEL_ROLES) {
    const candidate = record[role];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    const candidateRecord = candidate as Record<string, unknown>;
    const modelName = readStringField(candidateRecord, ["modelName", "model"]);
    if (!modelName) {
      continue;
    }

    const baseURL = readStringField(candidateRecord, ["baseURL", "baseUrl"]);
    const sanitized: SanitizedModelRoleConfig = {
      role,
      modelName,
    };
    if (baseURL) {
      sanitized.baseURL = baseURL;
    }
    result[role] = sanitized;
  }

  return result;
}
