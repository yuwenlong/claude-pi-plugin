/**
 * 可选配置。
 *
 * 设计取向是「零配置可用」：不写配置文件时，provider / model 一概不传给 pi，
 * 由 pi 自己的 settings.json 决定默认值，凭据也走 pi 已有的 ~/.pi/agent/auth.json。
 * 配置文件只用来覆盖默认值或补充 API key。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_DIR = join(homedir(), ".claude-pi-plugin");
export const CONFIG_PATH = join(STATE_DIR, "config.json");

const DEFAULTS = {
  providers: {},
  defaults: {
    provider: undefined,
    model: undefined,
    thinkingLevel: undefined,
  },
  limits: {
    maxConcurrentAgents: 5,
    defaultTimeoutMs: 180_000,
    daemonIdleTimeoutMs: 30 * 60_000,
  },
};

/** 深合并一层：providers/defaults/limits 各自浅合并。 */
export function mergeConfig(base, override = {}) {
  return {
    providers: { ...base.providers, ...(override.providers ?? {}) },
    defaults: { ...base.defaults, ...(override.defaults ?? {}) },
    limits: { ...base.limits, ...(override.limits ?? {}) },
  };
}

export function loadConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) return mergeConfig(DEFAULTS);
  try {
    return mergeConfig(DEFAULTS, JSON.parse(readFileSync(path, "utf8")));
  } catch {
    // 配置写坏了不该让整个插件不可用，退回默认值。
    return mergeConfig(DEFAULTS);
  }
}

const ENV_VAR_BY_PROVIDER = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  moonshotai: "MOONSHOTAI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  huggingface: "HF_TOKEN",
  zai: "ZAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
};

export function providerEnvVar(provider) {
  return ENV_VAR_BY_PROVIDER[provider] ?? `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/** 把配置里写死的 key / baseUrl 翻译成给 pi 子进程的环境变量。 */
export function resolveAuthEnv(provider, config) {
  const env = {};
  if (!provider) return env;
  const entry = config.providers?.[provider];
  if (!entry) return env;

  const name = entry.apiKeyEnvVar ?? providerEnvVar(provider);
  if (entry.apiKey) env[name] = entry.apiKey;
  if (entry.baseUrl) env[`${name.replace(/_API_KEY$/, "")}_BASE_URL`] = entry.baseUrl;
  return env;
}

/** 合并命令行覆盖项与配置默认值，得出真正要用的 provider/model/thinking。 */
export function resolveAgentOptions(config, overrides = {}) {
  const provider = overrides.provider ?? config.defaults.provider;
  const model = overrides.model ?? config.defaults.model ?? (provider ? config.providers?.[provider]?.defaultModel : undefined);
  const thinkingLevel = overrides.thinkingLevel ?? config.defaults.thinkingLevel;
  return { provider, model, thinkingLevel };
}
