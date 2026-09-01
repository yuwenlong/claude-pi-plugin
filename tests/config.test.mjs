import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  mergeConfig,
  resolveAuthEnv,
  resolveAgentOptions,
  providerEnvVar,
} from "../scripts/lib/config.mjs";

function configFile(contents) {
  const dir = mkdtempSync(join(tmpdir(), "claude-pi-test-"));
  const path = join(dir, "config.json");
  writeFileSync(path, contents);
  return path;
}

test("没有配置文件时退回内置默认值", () => {
  const config = loadConfig(join(tmpdir(), "claude-pi-does-not-exist.json"));
  assert.equal(config.limits.maxConcurrentAgents, 5);
  assert.equal(config.defaults.provider, undefined);
  assert.equal(config.limits.extensionDialogTimeoutMs, 30_000);
});

test("配置写坏了也不让插件崩，退回默认值", () => {
  const config = loadConfig(configFile("{ 这不是 JSON"));
  assert.equal(config.limits.defaultTimeoutMs, 180_000);
});

test("用户配置逐段覆盖，未提及的字段保留默认", () => {
  const config = loadConfig(configFile(JSON.stringify({ limits: { maxConcurrentAgents: 9 } })));
  assert.equal(config.limits.maxConcurrentAgents, 9);
  assert.equal(config.limits.defaultTimeoutMs, 180_000);
});

test("mergeConfig 对三个分段各自浅合并", () => {
  const base = mergeConfig({ providers: { a: { defaultModel: "m" } }, defaults: { provider: "a" }, limits: { x: 1 } });
  const merged = mergeConfig(base, { defaults: { model: "n" } });
  assert.equal(merged.defaults.provider, "a");
  assert.equal(merged.defaults.model, "n");
});

test("provider 环境变量名：已知的走映射表，未知的按规则推导", () => {
  assert.equal(providerEnvVar("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(providerEnvVar("kimi-coding"), "KIMI_CODING_API_KEY");
});

test("resolveAuthEnv 把配置里的 key 与 baseUrl 翻译成环境变量", () => {
  const config = mergeConfig({
    providers: { groq: { apiKey: "sk-x", baseUrl: "https://example.test" } },
    defaults: {},
    limits: {},
  });
  assert.deepEqual(resolveAuthEnv("groq", config), {
    GROQ_API_KEY: "sk-x",
    GROQ_BASE_URL: "https://example.test",
  });
});

test("未配置的 provider 不注入任何环境变量，交给 pi 自己的凭据", () => {
  const config = mergeConfig({ providers: {}, defaults: {}, limits: {} });
  assert.deepEqual(resolveAuthEnv("kimi-coding", config), {});
  assert.deepEqual(resolveAuthEnv(undefined, config), {});
});

test("命令行覆盖优先于配置默认值", () => {
  const config = mergeConfig({ providers: {}, defaults: { provider: "a", model: "m" }, limits: {} });
  assert.deepEqual(resolveAgentOptions(config, { model: "n" }), {
    provider: "a",
    model: "n",
    thinkingLevel: undefined,
  });
});

test("零配置时不指定 provider/model，由 pi 自行决定", () => {
  const config = mergeConfig({ providers: {}, defaults: {}, limits: {} });
  assert.deepEqual(resolveAgentOptions(config), {
    provider: undefined,
    model: undefined,
    thinkingLevel: undefined,
  });
});

test("provider 的 defaultModel 在没有其它来源时兜底", () => {
  const config = mergeConfig({
    providers: { groq: { defaultModel: "gpt-oss-120b" } },
    defaults: { provider: "groq" },
    limits: {},
  });
  assert.equal(resolveAgentOptions(config).model, "gpt-oss-120b");
});
