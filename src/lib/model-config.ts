export const DEFAULT_MODEL_NAME = "openai:gpt-4.1-mini";

export const GLOBAL_API_KEY_ENV = "APP_BUILDER_API_KEY";

export const GLOBAL_BASE_URL_ENV = "APP_BUILDER_BASE_URL";

export const GLOBAL_USER_AGENT_ENV = "APP_BUILDER_USER_AGENT";

export const GLOBAL_PROTOCOL_ENV = "APP_BUILDER_PROTOCOL";

export const GLOBAL_MAX_TOKENS_ENV = "APP_BUILDER_MAX_TOKENS";

export const GLOBAL_MAX_INPUT_TOKENS_ENV = "APP_BUILDER_MAX_INPUT_TOKENS";

export const DEFAULT_MODEL_MAX_TOKENS = 16384;

export const MODEL_ROLES = ["plan", "generate", "repair"] as const;

export type ModelRole = typeof MODEL_ROLES[number];

export const MODEL_PROTOCOLS = ["openai", "anthropic"] as const;

export type ModelProtocol = typeof MODEL_PROTOCOLS[number];

export type ModelRoleConfig = {
  role: ModelRole;
  modelName: string;
  protocol: ModelProtocol;
  baseURL?: string;
  userAgent?: string;
  maxInputTokens?: number;
  maxTokens?: number;
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

function parseModelProtocol(value: string | undefined, source: string): ModelProtocol | undefined {
  if (!value) {
    return undefined;
  }

  if (value === "openai" || value === "anthropic") {
    return value;
  }

  throw new Error(`${source} must be one of: ${MODEL_PROTOCOLS.join(", ")}.`);
}

function parseMaxTokens(value: string | undefined, source: string): number | undefined {
  if (!value) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`${source} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${source} must be a positive integer.`);
  }

  return parsed;
}

function normalizeMaxTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function roleEnvPrefix(role: ModelRole): string {
  return `APP_BUILDER_${role.toUpperCase()}`;
}

function roleApiKeyEnvName(role: ModelRole): string {
  return `${roleEnvPrefix(role)}_API_KEY`;
}

function roleUserAgentEnvName(role: ModelRole): string {
  return `${roleEnvPrefix(role)}_USER_AGENT`;
}

function roleProtocolEnvName(role: ModelRole): string {
  return `${roleEnvPrefix(role)}_PROTOCOL`;
}

function roleMaxTokensEnvName(role: ModelRole): string {
  return `${roleEnvPrefix(role)}_MAX_TOKENS`;
}

function roleMaxInputTokensEnvName(role: ModelRole): string {
  return `${roleEnvPrefix(role)}_MAX_INPUT_TOKENS`;
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
  const userAgent = readEnvValue(env, roleUserAgentEnvName(role)) ?? readEnvValue(env, GLOBAL_USER_AGENT_ENV);
  const apiKey = readEnvValue(env, roleApiKeyEnvName(role)) ?? readEnvValue(env, GLOBAL_API_KEY_ENV);
  const maxInputTokens =
    parseMaxTokens(readEnvValue(env, roleMaxInputTokensEnvName(role)), roleMaxInputTokensEnvName(role)) ??
    parseMaxTokens(readEnvValue(env, GLOBAL_MAX_INPUT_TOKENS_ENV), GLOBAL_MAX_INPUT_TOKENS_ENV) ??
    normalizeMaxTokens(persisted?.maxInputTokens);
  const maxTokens =
    parseMaxTokens(readEnvValue(env, roleMaxTokensEnvName(role)), roleMaxTokensEnvName(role)) ??
    parseMaxTokens(readEnvValue(env, GLOBAL_MAX_TOKENS_ENV), GLOBAL_MAX_TOKENS_ENV) ??
    normalizeMaxTokens(persisted?.maxTokens) ??
    DEFAULT_MODEL_MAX_TOKENS;
  const roleProtocolValue = readEnvValue(env, roleProtocolEnvName(role));
  const globalProtocolValue = readEnvValue(env, GLOBAL_PROTOCOL_ENV);
  const protocol =
    parseModelProtocol(roleProtocolValue, roleProtocolEnvName(role)) ??
    parseModelProtocol(globalProtocolValue, GLOBAL_PROTOCOL_ENV) ??
    persisted?.protocol ??
    "openai";
  const config: ModelRoleConfig = {
    role,
    modelName,
    protocol,
  };

  if (baseURL) {
    config.baseURL = baseURL;
  }

  if (userAgent) {
    config.userAgent = userAgent;
  }

  if (maxInputTokens) {
    config.maxInputTokens = maxInputTokens;
  }

  if (maxTokens) {
    config.maxTokens = maxTokens;
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
    protocol: config.protocol,
  };

  if (config.baseURL) {
    sanitized.baseURL = config.baseURL;
  }

  if (config.userAgent) {
    sanitized.userAgent = config.userAgent;
  }

  if (config.maxInputTokens) {
    sanitized.maxInputTokens = config.maxInputTokens;
  }

  if (config.maxTokens) {
    sanitized.maxTokens = config.maxTokens;
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

function readMaxTokensField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = normalizeMaxTokens(record[key]);
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
    const userAgent = readStringField(candidateRecord, ["userAgent"]);
    const protocol = parseModelProtocol(readStringField(candidateRecord, ["protocol"]), `models.${role}.protocol`);
    const maxInputTokens = readMaxTokensField(candidateRecord, [
      "maxInputTokens",
      "max_input_tokens",
      "contextWindowTokens",
      "context_window_tokens",
    ]);
    const maxTokens = readMaxTokensField(candidateRecord, ["maxTokens", "max_tokens"]);
    const sanitized: SanitizedModelRoleConfig = {
      role,
      modelName,
      protocol: protocol ?? "openai",
    };
    if (baseURL) {
      sanitized.baseURL = baseURL;
    }
    if (userAgent) {
      sanitized.userAgent = userAgent;
    }
    if (maxInputTokens) {
      sanitized.maxInputTokens = maxInputTokens;
    }
    if (maxTokens) {
      sanitized.maxTokens = maxTokens;
    }
    result[role] = sanitized;
  }

  return result;
}
