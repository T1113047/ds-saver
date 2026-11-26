/**
 * ds-saver — 本机 OpenCode 上下文/杂活插件
 *
 * 模型策略（2026-11-26 定稿）：
 * - 主模型：DeepSeek 官方 `deepseek-flash`（V4.1 Flash 1017）
 * - 杂活模型：只用三家便宜的官方 API
 *     1) 腾讯混元 Hy4 Flash    `hy4-flash`
 *     2) 小米 MiMo V2.6 Flash  `mimo-v2.6-flash`
 *     3) 阿里 Qwen3.8 Flash    `qwen3.8-flash`
 * - 不读取本机 scnet / alibaba-cn 等路由别名；自定义 provider 走配置文件。
 *
 * 设计：
 * - misc：便宜模型筛选工具输出/日志/文档，主模型只看短结论
 * - misc 的 agent 模式：只读文件循环（最多 3 轮），不跑 shell、不改文件
 * - ctx_status：只读计量（复用本机 ctx-usage.py）
 * - handoff：在质量拐点交接换窗（默认策略，优于原地焚化）
 *
 * 运行时由 OpenCode 2.4.x 的 Bun 加载；只依赖 node: 内建模块 + 全局 fetch。
 */

import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLUGIN_ID = "ds-saver";
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 新前缀优先，旧 CTX_MEMORY_ 前缀继续兼容；空字符串视为未设置 */
function envFirst(name) {
  for (const prefix of ["DS_SAVER_", "CTX_MEMORY_"]) {
    const value = process.env[`${prefix}${name}`];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

const WORKSPACE = envFirst("WORKSPACE") || process.cwd();
const HANDOFF_DIR = envFirst("HANDOFF_DIR") || path.join(WORKSPACE, ".handoff");
const CTX_USAGE_SCRIPT =
  envFirst("CTX_USAGE") ||
  path.join(WORKSPACE, "本地索引/99-工具/ctx-usage.py");
const SESSION_METRICS_SCRIPT =
  envFirst("SESSION_METRICS") ||
  path.join(PLUGIN_DIR, "scripts/session-metrics.py");
const SESSION_FORECAST_SCRIPT =
  envFirst("SESSION_FORECAST") ||
  path.join(PLUGIN_DIR, "scripts/session-forecast.py");

/** 数据目录：新目录存在则用新目录；否则旧目录有数据时回退旧目录 */
const DATA_ROOT_NEW = path.join(os.homedir(), ".local/share/opencode/ds-saver");
const DATA_ROOT_OLD = path.join(os.homedir(), ".local/share/opencode/ctx-memory");
const DATA_ROOT =
  existsSync(DATA_ROOT_NEW) || !existsSync(DATA_ROOT_OLD)
    ? DATA_ROOT_NEW
    : DATA_ROOT_OLD;

const METRICS_FILE =
  envFirst("METRICS_FILE") || path.join(DATA_ROOT, "metrics.jsonl");
const CALIBRATION_DIR =
  envFirst("CALIBRATION_DIR") || path.join(DATA_ROOT, "calibration");
const CALIBRATION_FILE =
  envFirst("CALIBRATION_FILE") || path.join(CALIBRATION_DIR, "latest.json");
const LAST_FORECAST_FILE =
  envFirst("LAST_FORECAST") || path.join(DATA_ROOT, "last-forecast.json");

/** 配置：新文件不存在但旧文件存在时，继续读旧配置 */
const CONFIG_PATH_NEW = path.join(os.homedir(), ".config/opencode/ds-saver.json");
const CONFIG_PATH_OLD = path.join(os.homedir(), ".config/opencode/ctx-memory.json");
const CONFIG_PATH =
  envFirst("CONFIG") ||
  (!existsSync(CONFIG_PATH_NEW) && existsSync(CONFIG_PATH_OLD)
    ? CONFIG_PATH_OLD
    : CONFIG_PATH_NEW);

/** 三家官方 provider 的默认值；配置文件可按 provider 覆盖 */
const OFFICIAL = {
  hy4: {
    label: "腾讯混元 Hy4 Flash",
    baseURL: "https://tokenhub.tencentmaas.com/v1",
    model: "hy4-flash",
    apiKeyEnv: "TOKENHUB_API_KEY",
    body: { reasoning_effort: "no_think" },
  },
  mimo: {
    label: "小米 MiMo V2.6 Flash",
    baseURL: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.6-flash",
    apiKeyEnv: "MIMO_API_KEY",
  },
  qwen: {
    label: "阿里 Qwen3.8 Flash",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.8-flash",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    body: { enable_thinking: false },
  },
};

const DEFAULT_ORDER = ["hy4", "mimo", "qwen"];

/** 口头名 → provider 名 */
const ALIASES = {
  auto: "auto",
  hy4: "hy4",
  hunyuan: "hy4",
  "hy4-flash": "hy4",
  混元: "hy4",
  mimo: "mimo",
  "mimo2.6": "mimo",
  "mimo2.6-flash": "mimo",
  小米: "mimo",
  qwen: "qwen",
  "qwen3.8": "qwen",
  "qwen3.8-flash": "qwen",
  千问: "qwen",
};

const TEXT_EXT = new Set([
  ".md", ".txt", ".log", ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts",
  ".tsx", ".jsx", ".py", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml",
  ".ini", ".conf", ".css", ".scss", ".html", ".vue", ".svelte", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".sql", ".csv", ".xml",
]);

const SECRET_PATH =
  /(^|\/)(03-密钥|\.env[^/]*|auth\.json|(?:ctx-memory|ds-saver)\.json|opencode\.jsonc?|credentials?|secrets?|id_rsa|id_ed25519)(\/|$)/i;
const SECRET_EXT = /\.(pem|key|p12|pfx|jks)$/i;
const SECRET_CONTENT = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\btp-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/i,
];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

function assertSafePath(file) {
  const normalized = file.replaceAll("\\", "/");
  if (SECRET_PATH.test(normalized) || SECRET_EXT.test(normalized)) {
    throw new Error(`拒绝读取敏感路径：${file}`);
  }
}

function assertNoSecrets(text) {
  for (const re of SECRET_CONTENT) {
    if (re.test(text)) {
      throw new Error("拒绝外发：材料中疑似包含密钥/令牌，已中止");
    }
  }
}

async function readTextFile(file, maxChars) {
  const stat = await fs.stat(file);
  if (!stat.isFile()) return null;
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) return null;
  const raw = await fs.readFile(file, "utf8");
  if (raw.includes("\u0000")) return null;

  const lines = raw.split(/\r?\n/);
  const numbered = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = `${i + 1}: ${lines[i]}`;
    if (used + line.length + 1 > maxChars) {
      numbered.push(`... [已截断：共 ${lines.length} 行] ...`);
      break;
    }
    numbered.push(line);
    used += line.length + 1;
  }
  return { path: file, text: numbered.join("\n"), lines: lines.length };
}

async function walkFiles(dir, out, budget) {
  if (out.length >= budget) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= budget) return;
    const full = path.join(dir, entry.name);
    if (SECRET_PATH.test(full.replaceAll("\\", "/"))) continue;
    if (entry.isDirectory()) {
      if (
        [".git", "node_modules", ".next", "dist", "build", ".rag-sanitized",
          "07-历史截图", ".handoff"].includes(entry.name)
      ) continue;
      await walkFiles(full, out, budget);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

function expandGlob(dir, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`,
  );
  return fs
    .readdir(dir, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((e) => e.isFile() && re.test(e.name))
        .map((e) => path.join(dir, e.name)),
    );
}

async function gatherMaterial(root, pathsInput, maxChars) {
  const inputs = Array.isArray(pathsInput) ? pathsInput : [];
  const files = [];
  const budget = 400;

  for (const raw of inputs) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
    assertSafePath(abs);

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      await walkFiles(abs, files, budget);
      continue;
    }

    if (stat.isFile()) {
      const base = path.basename(abs);
      if (/[*?]/.test(base)) {
        const found = await expandGlob(path.dirname(abs), base);
        files.push(...found);
      } else {
        files.push(abs);
      }
    }
  }

  const chunks = [];
  let used = 0;
  let omitted = 0;
  for (const file of files) {
    if (used >= maxChars) {
      omitted += 1;
      continue;
    }
    try {
      assertSafePath(file);
      const part = await readTextFile(file, Math.min(8000, maxChars - used));
      if (!part) continue;
      const header = `\n--- ${part.path} (${part.lines} 行) ---\n`;
      const body = part.text;
      if (used + header.length + body.length > maxChars) {
        const room = Math.max(0, maxChars - used - header.length);
        chunks.push(header + body.slice(0, room) + "\n... [材料已达上限] ...");
        used = maxChars;
      } else {
        chunks.push(header + body);
        used += header.length + body.length;
      }
    } catch {
      omitted += 1;
    }
  }

  let material = chunks.join("\n");
  if (omitted > 0) {
    material += `\n\n[另有 ${omitted} 个文件因敏感或超限未纳入]`;
  }
  if (material) assertNoSecrets(material);
  return { material, fileCount: files.length, chars: material.length };
}

function capLines(text, maxLines) {
  const cleaned = String(text || "")
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "")
    .replace(/\r/g, "")
    .trim();
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(0, maxLines).join("\n");
}

function buildFilterPrompt(task, material, maxLines) {
  return [
    "你是主模型的筛选器，只做信息压缩，不做推理扩展。",
    `任务：${task}`,
    "",
    "规则：",
    "1. 只使用“材料”中的内容；材料没有的，写“材料未提及”，不要猜。",
    `2. 每条一行，最多 ${maxLines} 行。`,
    "3. 每条尽量以 `路径:行号` 或 `来源` 开头；无法定位就写 `来源:材料`。",
    "4. 只保留与任务直接相关的事实、数字、错误、路径；删掉客套、背景、建议。",
    "5. 不要输出 Markdown 表格、代码块或标题。",
    "",
    "材料：",
    material || "(无材料；请只列出主模型完成任务还缺哪些信息，最多 5 行)",
  ].join("\n");
}

function buildAgentPrompt(task, material, maxLines, finalRound) {
  return [
    "你是一个只读的杂活子 agent，只有一个工具：read（读文件）。",
    "不要修改文件，不要执行命令，不要建议主模型怎么做。",
    `任务：${task}`,
    "",
    "输出规则：",
    "- 需要更多文件时，只输出一行 JSON：{\"read\":[\"路径1\",\"路径2\"]}，最多 4 个路径。",
    `- 否则输出最终结论：最多 ${maxLines} 行，每条带来源；不要复述过程。`,
    finalRound ? "- 这是最后一轮，必须直接给结论，不能再请求读文件。" : "",
    "",
    material ? `已给材料：\n${material}` : "没有预置材料；需要时用 read 工具。",
  ].join("\n");
}

function parseReadRequest(text) {
  const raw = String(text || "").trim();
  const candidates = [
    raw,
    raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
  ];
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (
        Array.isArray(obj?.read) &&
        obj.read.length > 0 &&
        obj.read.every((x) => typeof x === "string")
      ) {
        return obj.read.slice(0, 4);
      }
    } catch {
      // 继续尝试其它形态
    }
  }
  const match = raw.match(/\{[\s\S]*?"read"[\s\S]*?\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]);
      if (Array.isArray(obj?.read)) {
        return obj.read.filter((x) => typeof x === "string").slice(0, 4);
      }
    } catch {
      // 不是合法 JSON
    }
  }
  return null;
}

let configCache = null;

async function loadConfig() {
  if (configCache) return configCache;

  let user = {};
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    user = JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw new Error(`读取配置失败 ${CONFIG_PATH}: ${err.message}`);
    }
  }

  const providers = {};
  for (const [name, def] of Object.entries(OFFICIAL)) {
    providers[name] = { ...def };
  }
  for (const [name, override] of Object.entries(user.providers || {})) {
    providers[name] = { ...(providers[name] || {}), ...override };
  }

  const order =
    Array.isArray(user.order) && user.order.length
      ? user.order.filter((x) => typeof x === "string")
      : [...DEFAULT_ORDER];

  configCache = {
    ...user,
    providers,
    order,
    timeoutSec: clampInt(user.timeoutSec, 5, 300, 60),
    maxOutputTokens: clampInt(user.maxOutputTokens, 256, 8192, 2048),
  };
  return configCache;
}

function resolveTargets(config, requested) {
  const key = String(requested || "auto").trim();

  if (key === "auto" || ALIASES[key] === "auto") return [...config.order];

  if (config.providers[key]) return [key];

  const alias = ALIASES[key];
  if (alias && config.providers[alias]) return [alias];

  if (key.includes("/")) {
    const slash = key.indexOf("/");
    const provider = key.slice(0, slash);
    const model = key.slice(slash + 1);
    if (config.providers[provider] && model) {
      return [{ name: provider, model }];
    }
  }

  const names = Object.keys(config.providers).join(", ");
  throw new Error(`未知模型 "${key}"；可用：${names}，或 provider/model`);
}

function apiKeyFor(provider, name) {
  return (
    provider.apiKey ||
    (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : "") ||
    envFirst(`${name.toUpperCase()}_KEY`) ||
    ""
  );
}

function normalizeTarget(config, target) {
  if (typeof target === "string") {
    return { name: target, model: config.providers[target]?.model };
  }
  return { name: target.name, model: target.model || config.providers[target.name]?.model };
}

async function callProvider(config, targetInput, prompt, opts = {}) {
  const target = normalizeTarget(config, targetInput);
  const provider = config.providers[target.name];
  if (!provider) throw new Error(`${target.name}: provider 未配置`);

  const apiKey = apiKeyFor(provider, target.name);
  if (!apiKey) {
    throw new Error(
      `${target.name}: 缺少 API Key（设置 ${provider.apiKeyEnv || `DS_SAVER_${target.name.toUpperCase()}_KEY`} 或旧版 CTX_MEMORY_${target.name.toUpperCase()}_KEY，或配置文件 apiKey）`,
    );
  }

  const timeoutSec = clampInt(
    opts.timeoutSec ?? provider.timeoutSec ?? config.timeoutSec,
    5,
    300,
    60,
  );
  const maxTokens = clampInt(
    opts.maxTokens ?? provider.maxOutputTokens ?? config.maxOutputTokens,
    128,
    8192,
    2048,
  );

  const url = `${String(provider.baseURL).replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: target.model || provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false,
    ...(provider.body || {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutSec * 1000),
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    throw new Error(`${target.name}: HTTP ${res.status} ${detail}`.trim());
  }

  const json = await res.json().catch(() => null);
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error(`${target.name}: 返回空文本`);
  }

  return {
    text,
    provider: target.name,
    model: body.model,
    usage: json?.usage || null,
  };
}

async function callWithFallback(config, requested, prompt, opts = {}) {
  const targets = resolveTargets(config, requested);
  const errors = [];

  for (const target of targets) {
    try {
      return await callProvider(config, target, prompt, opts);
    } catch (err) {
      errors.push(String(err?.message || err));
    }
  }

  throw new Error(`杂活模型全部失败：\n- ${errors.join("\n- ")}`);
}

async function runReadAgent(config, root, opts) {
  const {
    task,
    material,
    maxLines,
    requestedModel,
    maxChars,
    timeoutSec,
    rounds,
  } = opts;

  let current = material || "";
  const maxRounds = clampInt(rounds, 1, 3, 3);

  for (let round = 0; round < maxRounds; round += 1) {
    const finalRound = round === maxRounds - 1;
    const prompt = buildAgentPrompt(task, current, maxLines, finalRound);
    const result = await callWithFallback(config, requestedModel, prompt, {
      timeoutSec,
    });

    if (!finalRound) {
      const readRequest = parseReadRequest(result.text);
      if (readRequest) {
        const extra = await gatherMaterial(
          root,
          readRequest,
          Math.max(2000, maxChars - current.length),
        );
        if (extra.material) {
          current += `\n${extra.material}`;
          continue;
        }
      }
    }

    if (finalRound && parseReadRequest(result.text)) {
      return {
        text: "（agent 最后一轮仍在请求读文件，未给结论；请缩小任务或直接用 paths 指定文件）",
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        rounds: round + 1,
      };
    }

    return {
      text: capLines(result.text, maxLines),
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      rounds: round + 1,
    };
  }

  throw new Error("只读 agent 未在轮次内返回结论");
}

function statusTool() {
  return {
    name: "ctx_status",
    description:
      "只读查看当前会话上下文占用、缓存命中与成本（调用本机 ctx-usage.py）。" +
      "在准备接新任务或考虑交接换窗前使用。",
    input: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(_input, toolCtx) {
      try {
        const { stdout, stderr } = await execFileAsync(
          "python3",
          [CTX_USAGE_SCRIPT, toolCtx.sessionID, "--json"],
          { timeout: 15000, maxBuffer: 1024 * 1024 },
        );
        const text = (stdout || stderr || "").trim();
        return {
          content: text || "(ctx-usage 无输出)",
          metadata: { sessionID: toolCtx.sessionID, script: CTX_USAGE_SCRIPT },
        };
      } catch (err) {
        return {
          content: `计量失败：${String(err?.message || err)}`,
          metadata: { sessionID: toolCtx.sessionID },
        };
      }
    },
  };
}

async function collectMetrics(sessionID) {
  const { stdout } = await execFileAsync(
    "python3",
    [SESSION_METRICS_SCRIPT, "--session", sessionID],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(String(stdout || "").trim());
}

async function appendMetrics(sessionID) {
  const data = await collectMetrics(sessionID);
  await fs.mkdir(path.dirname(METRICS_FILE), { recursive: true });
  await fs.appendFile(
    METRICS_FILE,
    `${JSON.stringify({ ts: new Date().toISOString(), ...data })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.chmod(METRICS_FILE, 0o600).catch(() => {});
  return data;
}

async function runForecastScript(sessionID, opts = {}) {
  const args = [SESSION_FORECAST_SCRIPT, "--session", sessionID];
  args.push("--calibration", opts.calibration ?? CALIBRATION_FILE);
  if (opts.handoffChars !== undefined) {
    args.push("--handoff-chars", String(clampInt(opts.handoffChars, 0, 20000, 1500)));
  }
  if (opts.taskDataTokens !== undefined) {
    args.push("--task-data-tokens", String(clampInt(opts.taskDataTokens, 0, 50000, 0)));
  }
  if (opts.target !== undefined) {
    args.push("--target", String(clampInt(opts.target, 100000, 900000, 500000)));
  }
  const { stdout } = await execFileAsync("python3", args, {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(String(stdout || "").trim());
}

function forecastTool() {
  return {
    name: "ctx_forecast",
    description:
      "预测下一次重开对话框的预注入 prompt token 与成本，并给出本次任务截至 token、" +
      "距 300/500/650/800K 的轮次区间（粗估）与 handoff 回本。确定性计算，不调用模型；" +
      "explain=true 时用 Qwen3.8 Flash 生成 3 行解释。",
    input: {
      type: "object",
      properties: {
        handoff_chars: {
          type: "integer",
          minimum: 0,
          maximum: 20000,
          description: "预计 handoff 文档字符数（默认 1500）",
        },
        task_data_tokens: {
          type: "integer",
          minimum: 0,
          maximum: 50000,
          description: "预计新会话额外注入的任务数据 token（默认 0）",
        },
        target: {
          type: "integer",
          minimum: 100000,
          maximum: 900000,
          description: "目标上下文，默认 500000",
        },
        explain: {
          type: "boolean",
          description: "true 时用 Qwen3.8 Flash 生成 3 行自然语言解释",
        },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input, toolCtx) {
      try {
        const data = await runForecastScript(toolCtx.sessionID, {
          handoffChars: input?.handoff_chars,
          taskDataTokens: input?.task_data_tokens,
          target: input?.target,
        });

        await fs.mkdir(path.dirname(LAST_FORECAST_FILE), { recursive: true });
        await fs.writeFile(
          LAST_FORECAST_FILE,
          JSON.stringify({ ts: new Date().toISOString(), ...data }),
          { encoding: "utf8", mode: 0o600 },
        );
        await fs.chmod(LAST_FORECAST_FILE, 0o600).catch(() => {});
        data.calibration_hint = {
          next_check_turns: 10,
          deviation_threshold_pct: 50,
          tool: "ctx_calibrate",
        };

        if (input?.explain) {
          try {
            const config = await loadConfig();
            const prompt = [
              "你是上下文管家。把下面的预测解释成 3 行中文：",
              "第一行结论，第二行风险，第三行建议。不要复述字段名。",
              JSON.stringify(data),
            ].join("\n");
            const result = await callWithFallback(config, "qwen", prompt, {
              timeoutSec: 30,
            });
            data.explanation = capLines(result.text, 3);
            data.explanation_model = result.model;
          } catch (err) {
            data.explanation_error = String(err?.message || err);
          }
        }

        return {
          content: JSON.stringify(data, null, 2),
          metadata: {
            zone: data.zone,
            turns_mid: data.growth?.turns_to_handoff_500k?.mid,
            next_p50: data.next_session?.p50?.prompt,
          },
        };
      } catch (err) {
        return {
          content: `预测失败：${String(err?.message || err)}`,
          metadata: {},
        };
      }
    },
  };
}

function calibrateTool() {
  return {
    name: "ctx_calibrate",
    description:
      "当 ctx_forecast 的预测与实际偏差超过阈值时，读最近一次预测快照，重算 growth/base 范围，" +
      "写 calibration/latest.json 与交接文档；explain=true 时用 Qwen3.8 Flash 写 5 行校准交接。",
    input: {
      type: "object",
      properties: {
        actual_turns: {
          type: "integer",
          minimum: 1,
          maximum: 100000,
          description: "距上次预测经过的 assistant 轮数（默认用消息数差）",
        },
        actual_context: {
          type: "integer",
          minimum: 1000,
          maximum: 1200000,
          description: "实际上下文 token；默认取当前会话",
        },
        actual_next_prompt: {
          type: "integer",
          minimum: 1000,
          maximum: 120000,
          description: "新会话首请求实际 prompt token（可选）",
        },
        actual_turns_to_500k: {
          type: "integer",
          minimum: 1,
          maximum: 100000,
          description: "实际到 500K 的轮次（可选）",
        },
        threshold_pct: { type: "integer", minimum: 5, maximum: 200 },
        explain: {
          type: "boolean",
          description: "true 时用 Qwen3.8 Flash 写 5 行校准交接",
        },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input, toolCtx) {
      try {
        const forecast = JSON.parse(
          await fs.readFile(LAST_FORECAST_FILE, "utf8"),
        );
        const current = await runForecastScript(toolCtx.sessionID, {
          calibration: path.join(CALIBRATION_DIR, "__none__.json"),
          handoffChars: forecast.next_session?.handoff_tokens,
          taskDataTokens: forecast.next_session?.task_data_tokens,
        });

        const currentContext = input?.actual_context ?? current.context;
        const elapsed = clampInt(
          input?.actual_turns,
          1,
          100000,
          Math.max(1, current.messages - (forecast.messages || 0)),
        );
        const oldG = Math.max(1, forecast.growth?.tokens_per_turn?.p50 || 1);
        const predictedContext = forecast.context + oldG * elapsed;
        const contextPct =
          Math.abs(predictedContext - currentContext) /
          Math.max(1, currentContext) *
          100;

        let promptPct = null;
        if (input?.actual_next_prompt) {
          const predictedPrompt = forecast.next_session?.p50?.prompt || 0;
          promptPct =
            Math.abs(predictedPrompt - input.actual_next_prompt) /
            Math.max(1, input.actual_next_prompt) *
            100;
        }

        let turnsPct = null;
        if (input?.actual_turns_to_500k) {
          const predictedTurns = forecast.growth?.turns_to_handoff_500k?.mid || 0;
          turnsPct =
            Math.abs(predictedTurns - input.actual_turns_to_500k) /
            Math.max(1, input.actual_turns_to_500k) *
            100;
        }

        const errors = [contextPct, promptPct, turnsPct].filter((x) => x !== null);
        const maxError = Math.max(...errors);
        const threshold = clampInt(input?.threshold_pct, 5, 200, 50);
        const deviation = {
          context_pct: round2(contextPct),
          prompt_pct: promptPct === null ? null : round2(promptPct),
          turns_pct: turnsPct === null ? null : round2(turnsPct),
          max_pct: round2(maxError),
          threshold_pct: threshold,
        };

        if (maxError <= threshold) {
          return {
            content: JSON.stringify(
              { triggered: false, deviation, message: "偏差在阈值内，不需要校准" },
              null,
              2,
            ),
            metadata: { triggered: false },
          };
        }

        const observedGrowth = Math.max(
          500,
          Math.min(50000, (currentContext - forecast.context) / elapsed),
        );
        const rawMultiplier = observedGrowth / oldG;
        const multiplier = Math.max(0.5, Math.min(2.0, rawMultiplier));
        const saturated = rawMultiplier > 2.0 || rawMultiplier < 0.5;
        const handoffTokens = forecast.next_session?.handoff_tokens || 0;
        const taskTokens = forecast.next_session?.task_data_tokens || 0;

        let base = null;
        if (input?.actual_next_prompt) {
          const p50 = Math.max(500, input.actual_next_prompt - handoffTokens - taskTokens);
          const ratio =
            (forecast.next_session?.p90?.prompt || p50) /
            Math.max(1, forecast.next_session?.p50?.prompt || p50);
          base = { prompt_p50: Math.round(p50), prompt_p90: Math.round(p50 * ratio) };
        }

        const g = forecast.growth?.tokens_per_turn || {
          p25: oldG,
          p50: oldG,
          p75: oldG,
        };
        const newG = (v) => Math.max(500, Math.min(50000, v * multiplier));
        const range = (target) => {
          if (currentContext >= target) {
            return { fast: 0, mid: 0, slow: 0, reached: true };
          }
          return {
            fast: round1((target - currentContext) / newG(g.p75)),
            mid: round1((target - currentContext) / newG(g.p50)),
            slow: round1((target - currentContext) / newG(g.p25)),
            reached: false,
          };
        };
        const ranges = {
          soft: range(300000),
          handoff: range(500000),
          hard: range(650000),
          max: range(800000),
        };

        const calibration = {
          schema: 1,
          ts: new Date().toISOString(),
          session_hash: current.session_hash,
          source: "ctx_calibrate",
          growth_multiplier: round2(multiplier),
          saturated,
          observed_growth: Math.round(observedGrowth),
          base,
          deviation,
          growth: {
            p25: Math.round(newG(g.p25)),
            p50: Math.round(newG(g.p50)),
            p75: Math.round(newG(g.p75)),
          },
          ranges,
          note: `observed_growth=${Math.round(observedGrowth)} old_g=${Math.round(oldG)} elapsed=${elapsed}`,
        };

        let agentNote = "（Qwen 未配置，使用确定性模板）";
        if (input?.explain !== false) {
          try {
            const config = await loadConfig();
            const prompt = [
              "你是上下文校准 agent。根据下面的偏差与重算参数，写 5 行中文交接文档：",
              "1 结论；2 偏差原因；3 新范围；4 风险；5 下一步。不要编造数字。",
              JSON.stringify({ deviation, calibration }),
            ].join("\n");
            const result = await callWithFallback(config, "qwen", prompt, {
              timeoutSec: 30,
            });
            agentNote = capLines(result.text, 5);
            calibration.agent_model = result.model;
          } catch (err) {
            calibration.agent_error = String(err?.message || err);
          }
        }

        const stamp = new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\..+/, "")
          .replace("T", "-");
        const doc = [
          `# Calibration — ${calibration.ts}`,
          "",
          "## 偏差",
          `- 上下文：预测 ${Math.round(predictedContext)} / 实际 ${currentContext} / 误差 ${deviation.context_pct}%`,
          `- 下次注入：${promptPct === null ? "未提供" : `误差 ${deviation.prompt_pct}%`}`,
          `- 到 500K 轮次：${turnsPct === null ? "未提供" : `预测 ${forecast.growth?.turns_to_handoff_500k?.mid} / 实际 ${input.actual_turns_to_500k} / 误差 ${deviation.turns_pct}%`}`,
          "",
          "## 新参数",
          `- growth_multiplier：${calibration.growth_multiplier}`,
          `- growth p25/p50/p75：${calibration.growth.p25} / ${calibration.growth.p50} / ${calibration.growth.p75}`,
          `- base prompt：${base ? `${base.prompt_p50} / ${base.prompt_p90}` : "未提供实际首请求，保持原值"}`,
          `- 新范围：300K ${ranges.soft.reached ? "已超过" : `${ranges.soft.fast}-${ranges.soft.slow} 轮`}；500K ${ranges.handoff.reached ? "已超过" : `${ranges.handoff.fast}-${ranges.handoff.slow} 轮`}；650K ${ranges.hard.reached ? "已超过" : `${ranges.hard.fast}-${ranges.hard.slow} 轮`}`,
          ...(saturated
            ? [`- ⚠️ multiplier 已触${rawMultiplier > 2 ? "上限" : "下限"}（原始 ${round2(rawMultiplier)}）：轮次预测不可信，按 300/500/650K 绝对阈值行动。`]
            : []),
          "",
          "## Agent 交接（Qwen3.8 Flash）",
          agentNote,
          "",
          "## 应用",
          "- 下一次 `ctx_forecast` 自动读取 `calibration/latest.json`。",
          "- 若偏差仍 > 阈值，再跑一次 `ctx_calibrate`，不要手动改阈值。",
          "",
        ].join("\n");

        await fs.mkdir(CALIBRATION_DIR, { recursive: true });
        const docPath = path.join(CALIBRATION_DIR, `calibration-${stamp}.md`);
        await fs.writeFile(docPath, doc, { encoding: "utf8", mode: 0o600 });
        const latest = { ...calibration, doc: docPath, agent_note: agentNote };
        await fs.writeFile(CALIBRATION_FILE, JSON.stringify(latest, null, 2), {
          encoding: "utf8",
          mode: 0o600,
        });
        await fs.chmod(CALIBRATION_FILE, 0o600).catch(() => {});

        return {
          content: JSON.stringify(
            { triggered: true, deviation, calibration, doc: docPath, agent_note: agentNote },
            null,
            2,
          ),
          metadata: {
            triggered: true,
            doc: docPath,
            growth_multiplier: calibration.growth_multiplier,
          },
        };
      } catch (err) {
        return {
          content: `校准失败：${String(err?.message || err)}`,
          metadata: { triggered: false },
        };
      }
    },
  };
}

function reportTool() {  return {
    name: "ctx_report",
    description:
      "采集一条匿名会话指标（上下文、累计思维链、C/R、工具/思维链占比、政策档位、成本），" +
      "写入本地 metrics.jsonl；不含提示词、正文、路径、密钥。用于插件的真实数据反馈与阈值校准。",
    input: {
      type: "object",
      properties: {
        write: {
          type: "boolean",
          description: "默认 true；false 只返回指标，不落盘",
        },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input, toolCtx) {
      try {
        const write = input?.write !== false;
        const data = write
          ? await appendMetrics(toolCtx.sessionID)
          : await collectMetrics(toolCtx.sessionID);
        return {
          content: JSON.stringify(data, null, 2),
          metadata: { written: write, path: write ? METRICS_FILE : null },
        };
      } catch (err) {
        return {
          content: `指标采集失败：${String(err?.message || err)}`,
          metadata: { written: false },
        };
      }
    },
  };
}

function slugify(text) {
  return (
    String(text || "handoff")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "handoff"
  );
}

function buildHandoff(input) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const list = (arr) =>
    Array.isArray(arr) && arr.length
      ? arr.map((x) => `- ${String(x)}`).join("\n")
      : "- （无）";

  const body = [
    `# Handoff — ${stamp}`,
    "",
    "## 目标",
    String(input?.next || "（未填写）"),
    "",
    "## 关键决定",
    list(input?.decisions),
    "",
    "## 涉及文件",
    list(input?.files),
    "",
    "## 未决问题",
    list(input?.open),
    "",
    "## 备注",
    String(input?.notes || "（无）"),
    "",
    "## 新会话开场",
    "读取本文件后继续；不要重复已完成的工作。先跑 `ctx_status` 看新窗口占用。",
    "",
  ].join("\n");

  return { stamp, body };
}

function handoffTool() {
  return {
    name: "handoff",
    description:
      "生成一份紧凑的交接文档并落盘，用于 55–60% 上下文时开新会话；" +
      "比原地焚化便宜一个数量级，且能重置质量。只写 markdown，不改生产文件。",
    input: {
      type: "object",
      properties: {
        next: { type: "string", description: "下一步要做什么" },
        decisions: { type: "array", items: { type: "string" } },
        files: { type: "array", items: { type: "string" } },
        open: { type: "array", items: { type: "string" } },
        notes: { type: "string" },
        write: { type: "boolean", description: "是否落盘（默认 true）" },
      },
      required: ["next"],
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input, toolCtx) {
      const { stamp, body } = buildHandoff(input);
      if (input?.write === false) {
        return { content: body, metadata: { written: false } };
      }
      await fs.mkdir(HANDOFF_DIR, { recursive: true });
      const file = path.join(
        HANDOFF_DIR,
        `handoff-${stamp}-${slugify(input?.next)}.md`,
      );
      await fs.writeFile(file, body, { encoding: "utf8", mode: 0o600 });

      let metrics = false;
      if (toolCtx?.sessionID) {
        try {
          await appendMetrics(toolCtx.sessionID);
          metrics = true;
        } catch {
          // 指标采集失败不影响交接
        }
      }

      return {
        content: `已写入：${file}\n\n${body}`,
        metadata: { path: file, written: true, metrics },
      };
    },
  };
}

function miscTool(root) {
  return {
    name: "misc",
    description:
      "用便宜官方模型做杂活：筛选大段工具输出/日志/文档、分类、提取要点，只把短结论传回主模型。" +
      "mode=filter 单次生成（最省）；mode=agent 只读文件循环（最多 3 轮，不跑 shell、不改文件）。" +
      "模型默认 混元 Hy4 Flash → MiMo V2.6 Flash → Qwen3.8 Flash；" +
      "不适合精确编辑、写文件或需要逐字保留原文的任务。",
    input: {
      type: "object",
      properties: {
        task: { type: "string", description: "要筛选/回答的具体问题" },
        mode: {
          type: "string",
          enum: ["filter", "agent"],
          description: "filter=单次筛选；agent=只读文件循环",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "要读取的文件/目录（相对会话目录或绝对路径）",
        },
        material: {
          type: "string",
          description: "直接提供的材料；与 paths 二选一或同时使用",
        },
        max_lines: { type: "integer", minimum: 1, maximum: 80 },
        max_input_chars: { type: "integer", minimum: 1000, maximum: 120000 },
        model: {
          type: "string",
          description:
            "auto（默认 hy4→mimo→qwen）| hy4 | mimo | qwen | provider/model（自定义）",
        },
        timeout_sec: { type: "integer", minimum: 5, maximum: 300 },
        rounds: {
          type: "integer",
          minimum: 1,
          maximum: 3,
          description: "agent 模式最多读几轮（默认 3）",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input) {
      const task = String(input?.task || "").trim();
      if (!task) throw new Error("task 不能为空");

      const config = await loadConfig();
      const mode = input?.mode === "agent" ? "agent" : "filter";
      const maxLines = clampInt(input?.max_lines, 1, 80, 20);
      const maxChars = clampInt(input?.max_input_chars, 1000, 120000, 24000);
      const timeoutSec = clampInt(input?.timeout_sec, 5, 300, 60);

      const gathered = await gatherMaterial(root, input?.paths, maxChars);
      const provided =
        typeof input?.material === "string" ? input.material.trim() : "";
      let combined = [gathered.material, provided].filter(Boolean).join("\n\n");
      if (combined) assertNoSecrets(combined);

      const metadata = {
        mode,
        files: gathered.fileCount,
        chars: gathered.chars + provided.length,
      };

      if (mode === "agent") {
        const result = await runReadAgent(config, root, {
          task,
          material: combined,
          maxLines,
          requestedModel: input?.model,
          maxChars,
          timeoutSec,
          rounds: input?.rounds,
        });
        return {
          content: result.text || "(agent 返回空)",
          metadata: {
            ...metadata,
            mode: "agent",
            provider: result.provider,
            model: result.model,
            rounds: result.rounds,
            usage: result.usage,
          },
        };
      }

      const prompt = buildFilterPrompt(task, combined, maxLines);
      const result = await callWithFallback(config, input?.model, prompt, {
        timeoutSec,
      });
      return {
        content: capLines(result.text, maxLines),
        metadata: {
          ...metadata,
          mode: "filter",
          provider: result.provider,
          model: result.model,
          usage: result.usage,
        },
      };
    },
  };
}

const DEFAULT_IGNORE = [
  ".git", "node_modules", "__pycache__", ".next", "dist", "build", "backups", "*.pyc",
];
const TREE_CHAR_LIMIT = 30000;
const RAG_MAX_FILES = 5000;
const RAG_MAX_FILE_BYTES = 512 * 1024;
const RAG_MAX_HITS = 2000;

function globToRegExp(pattern) {
  const src = String(pattern || "").replaceAll("\\", "/");
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "*" && src[i + 1] === "*" && src[i + 2] === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "*" && src[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function shouldIgnore(name, rel, patterns) {
  return patterns.some((pattern) => {
    const p = String(pattern || "").replaceAll("\\", "/").trim();
    if (!p) return false;
    if (!/[/*?]/.test(p)) return name === p;
    return globToRegExp(p).test(p.includes("/") ? rel : name);
  });
}

function resolveToolPath(root, rawPath) {
  const raw = typeof rawPath === "string" ? rawPath.trim() : "";
  const target = raw || ".";
  if (target.includes("\u0000")) throw new Error("路径非法");
  const abs = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target);
  assertSafePath(abs);
  if (!path.isAbsolute(target)) {
    const rel = path.relative(path.resolve(root), abs);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`拒绝越界路径：${rawPath}`);
    }
  }
  return abs;
}

async function buildTree(absRoot, opts) {
  const stat = await fs.stat(absRoot);
  if (!stat.isDirectory()) throw new Error(`不是目录：${absRoot}`);

  const ignore = [...DEFAULT_IGNORE, ...opts.ignore];
  const lines = [`${absRoot}/`];
  let chars = lines[0].length + 1;
  let entries = 0;
  let truncated = false;

  async function visit(dir, level, prefix) {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      lines.push(`${prefix}... [无法读取]`);
      return;
    }
    dirents.sort((a, b) =>
      a.isDirectory() === b.isDirectory()
        ? a.name.localeCompare(b.name)
        : a.isDirectory()
          ? -1
          : 1,
    );

    for (let i = 0; i < dirents.length; i += 1) {
      if (truncated) return;
      const entry = dirents[i];
      const full = path.join(dir, entry.name);
      const rel = path.relative(absRoot, full).replaceAll("\\", "/");
      if (SECRET_PATH.test(full.replaceAll("\\", "/"))) continue;
      if (entry.isSymbolicLink()) continue;
      if (shouldIgnore(entry.name, rel, ignore)) continue;

      if (entries >= opts.maxEntries) {
        truncated = true;
        return;
      }
      entries += 1;

      const branch = i === dirents.length - 1 ? "└─ " : "├─ ";
      const line = `${prefix}${branch}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      if (chars + line.length + 1 > TREE_CHAR_LIMIT) {
        truncated = true;
        return;
      }
      lines.push(line);
      chars += line.length + 1;

      if (entry.isDirectory() && level < opts.depth) {
        const nextPrefix = `${prefix}${i === dirents.length - 1 ? "   " : "│  "}`;
        await visit(full, level + 1, nextPrefix);
      }
    }
  }

  await visit(absRoot, 1, "");
  if (truncated) {
    lines.push(
      `... [已截断：maxEntries=${opts.maxEntries} / ${TREE_CHAR_LIMIT} 字符上限]`,
    );
  }
  return { text: lines.join("\n"), entries, truncated };
}

function treeTool(root) {
  return {
    name: "tree",
    description:
      "只读输出目录树（紧凑缩进）。默认忽略 .git/node_modules/__pycache__/.next/dist/build/backups/*.pyc；" +
      "拒绝 03-密钥、.env*、auth.json、私钥等敏感路径；结果超过上限会标注截断。",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录，默认 cwd；相对路径不得越出 cwd" },
        depth: { type: "integer", minimum: 1, maximum: 8, description: "默认 3，上限 8" },
        maxEntries: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          description: "默认 400，上限 2000",
        },
        ignore: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input) {
      const target = resolveToolPath(root, input?.path);
      const depth = clampInt(input?.depth, 1, 8, 3);
      const maxEntries = clampInt(input?.maxEntries, 1, 2000, 400);
      const ignore = Array.isArray(input?.ignore)
        ? input.ignore
            .filter((x) => typeof x === "string" && x.trim())
            .map((x) => x.trim())
        : [];
      const { text, entries, truncated } = await buildTree(target, {
        depth,
        maxEntries,
        ignore,
      });
      return {
        content: text,
        metadata: { root: target, depth, maxEntries, entries, truncated },
      };
    },
  };
}

async function collectRagFiles(dir, root, files, includeRe, budget) {
  if (files.length >= budget) return;
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of dirents) {
    if (files.length >= budget) return;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll("\\", "/");
    if (SECRET_PATH.test(full.replaceAll("\\", "/"))) continue;
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      if (shouldIgnore(entry.name, rel, DEFAULT_IGNORE)) continue;
      await collectRagFiles(full, root, files, includeRe, budget);
    } else if (entry.isFile()) {
      if (
        includeRe &&
        !includeRe.test(rel) &&
        !includeRe.test(entry.name)
      ) continue;
      if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(full);
    }
  }
}

function tokenizeQuery(query) {
  const q = String(query || "").trim().toLowerCase();
  const tokens = q.split(/[\s,;|/]+/).filter(Boolean);
  return [...new Set(tokens.length ? tokens : [q])].slice(0, 8);
}

async function ragSearch(root, query, topK, include) {
  const tokens = tokenizeQuery(query);
  if (!tokens.length) throw new Error("query 不能为空");
  const includeRe = include ? globToRegExp(include) : null;

  const stat = await fs.stat(root);
  const files = [];
  if (stat.isDirectory()) {
    await collectRagFiles(root, root, files, includeRe, RAG_MAX_FILES);
  } else if (stat.isFile()) {
    const rel = path.basename(root);
    if (!includeRe || includeRe.test(rel)) files.push(root);
  } else {
    throw new Error(`不是文件或目录：${root}`);
  }

  const hits = [];
  let total = 0;
  let scanned = 0;

  for (const file of files) {
    let fileStat;
    try {
      fileStat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!fileStat.isFile() || fileStat.size > RAG_MAX_FILE_BYTES) continue;

    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (raw.includes("\u0000")) continue;
    scanned += 1;

    const rel =
      path.relative(root, file).replaceAll("\\", "/") || path.basename(file);
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const lower = lines[i].toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (lower.includes(token)) score += 1;
      }
      if (!score) continue;
      if (score === tokens.length) score += 1;
      total += 1;
      if (hits.length >= RAG_MAX_HITS) continue;
      const excerpt = lines[i].trim().replace(/\s+/g, " ").slice(0, 200);
      hits.push({ file: rel, line: i + 1, score, excerpt, abs: file });
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  const picked = hits.slice(0, topK);
  return {
    text: picked.length
      ? picked.map((h) => `${h.file}:${h.line}: ${h.excerpt}`).join("\n")
      : "(无命中)",
    picked,
    total,
    scanned,
    files: files.length,
    truncated: total > picked.length,
  };
}

const RAG_FILTER_MAX_CANDIDATES = 12;
const RAG_FILTER_CONTEXT_CHARS = 800;

const oneLine = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim();

async function readRagCandidate(absFile, line, maxChars) {
  const raw = await fs.readFile(absFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, line - 3);
  const end = Math.min(lines.length, line + 2);
  const parts = [];
  let used = 0;
  for (let i = start; i < end; i += 1) {
    const piece = `${i + 1}: ${lines[i]}`;
    if (used + piece.length + 1 > maxChars) {
      parts.push(`${i + 1}: ... [上下文已截断]`);
      break;
    }
    parts.push(piece);
    used += piece.length + 1;
  }
  return parts.join("\n");
}

async function gatherRagCandidates(root, hits, maxCandidates) {
  const out = [];
  for (const hit of hits.slice(0, maxCandidates)) {
    const abs = hit.abs || path.resolve(root, hit.file);
    assertSafePath(abs);
    let context = `${hit.line}: ${hit.excerpt}`;
    try {
      context =
        (await readRagCandidate(abs, hit.line, RAG_FILTER_CONTEXT_CHARS)) ||
        context;
    } catch {
      // 读取失败时退回单行摘要，继续筛选
    }
    out.push({ path: hit.file, line: hit.line, context });
  }
  return out;
}

function buildRagFilterPrompt(query, candidates, maxPicks) {
  const blocks = candidates.map(
    (c) => `--- ${c.path}:${c.line} ---\n${c.context}`,
  );
  return [
    "你是检索结果的筛选器：只判断哪些候选真正支持回答 query，不做推理扩展。",
    `query：${query}`,
    "",
    "规则：",
    `1. 最多选 ${maxPicks} 条，宁少勿多；不确定时保留路径而不是正文。`,
    "2. 只能从给出的候选中选，不得编造路径或行号。",
    "3. 每条必须能回答：它支持哪个结论；说不出就删掉。",
    "4. 只输出 JSON 数组，不要解释、不要 Markdown 代码块。",
    '5. 元素格式：{"path":"相对路径","line":行号,"summary":"一句话摘要","reason":"为什么选它，支持哪个结论"}',
    "",
    "候选：",
    blocks.join("\n\n") || "(无候选)",
  ].join("\n");
}

function parseRagFilterSelection(text) {
  const raw = String(text || "");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) throw new Error("模型未返回 JSON 数组");
  const arr = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("模型返回不是 JSON 数组");
  return arr;
}

function normalizeCandidatePath(rawPath, root) {
  let s = String(rawPath || "").trim().replaceAll("\\", "/");
  if (s.startsWith("./")) s = s.slice(2);
  if (path.isAbsolute(s)) {
    assertSafePath(s);
    const rel = path.relative(root, s).replaceAll("\\", "/");
    if (rel && rel !== ".." && !rel.startsWith("../")) s = rel;
  } else {
    // 容错：模型可能带上检索根目录名
    const base = path.basename(String(root || "").replaceAll("\\", "/"));
    if (base && s.startsWith(`${base}/`)) s = s.slice(base.length + 1);
  }
  return s;
}

async function filterRagResult(config, root, query, hits, opts = {}) {
  const maxPicks = clampInt(opts.filterTopK, 1, 8, 5);
  const candidates = await gatherRagCandidates(
    root,
    Array.isArray(hits) ? hits : [],
    RAG_FILTER_MAX_CANDIDATES,
  );
  if (!candidates.length) throw new Error("没有候选可筛选");

  const known = new Set(
    candidates.map((c) => `${normalizeCandidatePath(c.path, root)}:${c.line}`),
  );
  const prompt = buildRagFilterPrompt(query, candidates, maxPicks);
  assertNoSecrets(prompt);

  const result = await callWithFallback(config, opts.model, prompt, {
    timeoutSec: config.timeoutSec,
  });
  const arr = parseRagFilterSelection(result.text);

  const picked = [];
  const seen = new Set();
  for (const item of arr) {
    if (picked.length >= maxPicks) break;
    const rel = normalizeCandidatePath(item?.path, root);
    const line = clampInt(item?.line, 1, Number.MAX_SAFE_INTEGER, 0);
    const key = `${rel}:${line}`;
    if (!line || !known.has(key) || seen.has(key)) continue;
    seen.add(key);
    picked.push({
      path: rel,
      line,
      summary: oneLine(item?.summary).slice(0, 120) || "(无摘要)",
      reason: oneLine(item?.reason).slice(0, 160) || "(未说明理由)",
    });
  }
  if (!picked.length) throw new Error("模型筛选结果为空或不在候选内");

  const lines = picked.map(
    (p) => `${p.path}:${p.line} — ${p.summary}（${p.reason}）`,
  );
  lines.push("", `picked ${picked.length} / candidates ${candidates.length}`);

  return {
    text: lines.join("\n"),
    picked: picked.length,
    candidates: candidates.length,
    provider: result.provider,
    model: result.model,
  };
}

function splitCommand(cmd) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(cmd))) parts.push(match[1] ?? match[2] ?? match[3]);
  return parts;
}

async function runRagCommand(cmd, query) {
  const parts = splitCommand(cmd);
  if (!parts.length) throw new Error("DS_SAVER_RAG_CMD 为空");
  const { stdout } = await execFileAsync(parts[0], [...parts.slice(1), query], {
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return String(stdout || "").trim();
}

function ragTool(root) {
  return {
    name: "rag",
    description:
      "轻量本地检索：优先执行 DS_SAVER_RAG_CMD（query 作为最后一个参数），未配置或失败时回退纯 Node 行匹配；" +
      "只读文本文件（单文件 512KB、最多 5000 个），拒绝敏感路径，返回「文件:行号: 摘要」。" +
      "filter=true 时先用便宜模型把候选筛到 3–5 条再注入；失败自动回退原始命中。",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词；空格分词，大小写不敏感" },
        path: { type: "string", description: "目录或文件，默认 cwd；相对路径不得越出 cwd" },
        topK: { type: "integer", minimum: 1, maximum: 30, description: "默认 8，上限 30" },
        include: { type: "string", description: "可选 glob，如 *.js 或 src/**/*.ts" },
        filter: {
          type: "boolean",
          description: "true 时先让便宜模型筛候选再注入（默认 false）",
        },
        filter_topK: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "筛选后最终注入条数，默认 5",
        },
        model: {
          type: "string",
          description:
            "筛选用的模型：auto | hy4 | mimo | qwen | provider/model（可选）",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    options: { codemode: false },
    async execute(input) {
      const query = String(input?.query || "").trim();
      if (!query) throw new Error("query 不能为空");
      const target = resolveToolPath(root, input?.path);
      const topK = clampInt(input?.topK, 1, 30, 8);
      const include =
        typeof input?.include === "string" && input.include.trim()
          ? input.include.trim()
          : "";
      const filter = input?.filter === true;
      const filterTopK = clampInt(input?.filter_topK, 1, 8, 5);
      // filter 需要结构化的路径/行号候选，因此强制走内置检索
      const ragCmd = filter ? "" : envFirst("RAG_CMD");

      if (ragCmd) {
        try {
          const text = await runRagCommand(ragCmd, query);
          return {
            content: text || "(rag 命令无输出)",
            metadata: {
              engine: "command",
              query,
              root: target,
              topK,
              include: include || null,
            },
          };
        } catch {
          // 命令失败时回退内置检索
        }
      }

      const result = await ragSearch(target, query, topK, include);
      const metadata = {
        engine: "builtin",
        query,
        root: target,
        topK,
        include: include || null,
        hits: result.total,
        scanned: result.scanned,
        files: result.files,
        truncated: result.truncated,
      };

      if (!filter) return { content: result.text, metadata };

      try {
        const config = await loadConfig();
        const filtered = await filterRagResult(config, target, query, result.picked, {
          filterTopK,
          model: input?.model,
        });
        return {
          content: filtered.text,
          metadata: {
            ...metadata,
            engine: "rag+filter",
            picked: filtered.picked,
            candidates: filtered.candidates,
            provider: filtered.provider,
            model: filtered.model,
          },
        };
      } catch (err) {
        return {
          content: result.text,
          metadata: {
            ...metadata,
            filter_fallback: true,
            filter_error: oneLine(err?.message || err).slice(0, 200),
          },
        };
      }
    },
  };
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    const root = ctx.location?.directory || WORKSPACE;

    await ctx.tool.transform((editor) => {
      editor.add(miscTool(root));
      editor.add(treeTool(root));
      editor.add(ragTool(root));
      editor.add(statusTool());
      editor.add(forecastTool());
      editor.add(calibrateTool());
      editor.add(reportTool());
      editor.add(handoffTool());
    });

    return async () => {};
  },
};

// 双端复用：DSH 适配层（dsh/index.js）只调用这里的纯逻辑入口。
export const core = {
  loadConfig,
  gatherMaterial,
  callWithFallback,
  buildTree,
  ragSearch,
  resolveToolPath,
  miscTool,
  treeTool,
  ragTool,
  handoffTool,
  buildHandoff,
};

export const __test = {
  OFFICIAL,
  DEFAULT_ORDER,
  ALIASES,
  loadConfig,
  resetConfig: () => {
    configCache = null;
  },
  resolveTargets,
  callProvider,
  callWithFallback,
  parseReadRequest,
  gatherMaterial,
  buildFilterPrompt,
  buildAgentPrompt,
  capLines,
  slugify,
  buildHandoff,
  globToRegExp,
  resolveToolPath,
  buildTree,
  ragSearch,
  envFirst,
  CONFIG_PATH,
  WORKSPACE,
};
