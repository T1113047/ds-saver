import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ds-saver-test-"));
const handoffDir = path.join(tmp, "handoff");
const configPath = path.join(tmp, "ctx-memory.json");

process.env.CTX_MEMORY_HANDOFF_DIR = handoffDir;
process.env.CTX_MEMORY_WORKSPACE = tmp;
process.env.CTX_MEMORY_CONFIG = configPath;
delete process.env.TOKENHUB_API_KEY;
delete process.env.MIMO_API_KEY;
delete process.env.DASHSCOPE_API_KEY;

const mod = await import("../index.js");
const plugin = mod.default;
const { __test } = mod;

assert.equal(__test.CONFIG_PATH, configPath, "旧 CTX_MEMORY_CONFIG 应继续兼容");
assert.equal(__test.WORKSPACE, tmp, "旧 CTX_MEMORY_WORKSPACE 应继续兼容");
process.env.DS_SAVER_PRIORITY_TEST = "new";
process.env.CTX_MEMORY_PRIORITY_TEST = "old";
assert.equal(__test.envFirst("PRIORITY_TEST"), "new", "DS_SAVER_ 应优先");
delete process.env.DS_SAVER_PRIORITY_TEST;
assert.equal(__test.envFirst("PRIORITY_TEST"), "old", "旧前缀应 fallback");
delete process.env.CTX_MEMORY_PRIORITY_TEST;

async function writeConfig(obj) {
  await fs.writeFile(configPath, JSON.stringify(obj, null, 2));
  __test.resetConfig();
}

function installFetch(handler) {
  const calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const call = { url, body, headers: init.headers };
    calls.push(call);
    return handler(call, calls.length);
  };
  return calls;
}

function ok(content, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage,
    }),
  };
}

function fail(status = 500, text = "boom") {
  return { ok: false, status, text: async () => text };
}

function fakeContext() {
  const tools = [];
  return {
    tools,
    ctx: {
      location: { directory: tmp },
      tool: {
        transform: async (cb) => {
          await cb({ add: (tool) => tools.push(tool) });
        },
      },
    },
  };
}

try {
  // 配置：只启用 hy4 → mimo，带测试 key
  await writeConfig({
    order: ["hy4", "mimo"],
    timeoutSec: 10,
    providers: {
      hy4: {
        baseURL: "https://tokenhub.test/v1",
        model: "hy4-flash",
        apiKey: "test-hy4",
      },
      mimo: {
        baseURL: "https://mimo.test/v1",
        model: "mimo-v2.6-flash",
        apiKey: "test-mimo",
      },
      custom: {
        baseURL: "https://custom.test/v1",
        model: "custom-default",
        apiKey: "test-custom",
      },
    },
  });

  const { ctx, tools } = fakeContext();
  await plugin.setup(ctx);

  assert.equal(tools.length, 8, "应注册 8 个工具");
  const misc = tools.find((t) => t.name === "misc");
  const tree = tools.find((t) => t.name === "tree");
  const rag = tools.find((t) => t.name === "rag");
  const status = tools.find((t) => t.name === "ctx_status");
  const forecast = tools.find((t) => t.name === "ctx_forecast");
  const calibrate = tools.find((t) => t.name === "ctx_calibrate");
  const report = tools.find((t) => t.name === "ctx_report");
  const handoff = tools.find((t) => t.name === "handoff");
  assert.ok(
    misc && tree && rag && status && forecast && calibrate && report && handoff,
    "工具名齐全",
  );
  for (const tool of tools) {
    assert.equal(tool.options.codemode, false, `${tool.name} 必须是直接工具`);
  }

  // 1) filter：官方 URL / 模型名 / 行号 / 截断
  const sample = path.join(tmp, "sample.md");
  await fs.writeFile(
    sample,
    ["模型价格", "Hy4 Flash 输入 0.5", "MiMo 输入 1", "Qwen 输入 0.8"].join("\n"),
  );

  let calls = installFetch(() =>
    ok("第一条 来源:a:1\n第二条 来源:b:2\n第三条 来源:c:3"),
  );
  const filtered = await misc.execute(
    { task: "列出模型价格", paths: [sample], max_lines: 2 },
    { sessionID: "ses_test" },
  );
  assert.equal(filtered.content.split("\n").length, 2, "输出应被 max_lines 截断");
  assert.equal(filtered.metadata.provider, "hy4");
  assert.equal(filtered.metadata.model, "hy4-flash");
  assert.equal(calls[0].url, "https://tokenhub.test/v1/chat/completions");
  assert.equal(calls[0].body.model, "hy4-flash");
  assert.equal(calls[0].headers.authorization, "Bearer test-hy4");
  assert.match(calls[0].body.messages[0].content, /Hy4 Flash 输入 0\.5/);
  assert.match(calls[0].body.messages[0].content, /1: 模型价格/);

  // 2) 第一家 500 → 第二家成功
  calls = installFetch((_call, n) =>
    n === 1 ? fail(500, "hy4 down") : ok("fallback 结论 来源:m:1"),
  );
  const fallback = await misc.execute(
    { task: "筛选", material: "x" },
    { sessionID: "ses_test" },
  );
  assert.equal(fallback.metadata.provider, "mimo");
  assert.equal(calls.length, 2);

  // 3) agent 只读循环：第一轮请求读文件，第二轮给结论
  const extra = path.join(tmp, "extra.md");
  await fs.writeFile(extra, "额外事实 42");
  calls = installFetch((_call, n) =>
    n === 1 ? ok(`{"read":["${extra}"]}`) : ok("最终结论 来源:extra:1"),
  );
  const agent = await misc.execute(
    { task: "找 42", mode: "agent", paths: [sample], max_lines: 5 },
    { sessionID: "ses_test" },
  );
  assert.equal(agent.metadata.mode, "agent");
  assert.equal(agent.metadata.rounds, 2);
  assert.equal(agent.content, "最终结论 来源:extra:1");
  assert.match(calls[1].body.messages[0].content, /额外事实 42/);

  // 4) 自定义 provider/model
  calls = installFetch(() => ok("ok"));
  await misc.execute(
    { task: "x", material: "y", model: "custom/my-model" },
    { sessionID: "ses_test" },
  );
  assert.equal(calls[0].url, "https://custom.test/v1/chat/completions");
  assert.equal(calls[0].body.model, "my-model");
  assert.equal(calls[0].headers.authorization, "Bearer test-custom");

  // 5) 敏感路径 / 敏感内容
  const secretDir = path.join(tmp, "03-密钥");
  await fs.mkdir(secretDir, { recursive: true });
  await fs.writeFile(path.join(secretDir, "x.md"), "secret");
  await assert.rejects(
    () => misc.execute({ task: "看", paths: ["03-密钥/x.md"] }, { sessionID: "ses_test" }),
    /拒绝读取敏感路径/,
  );
  await assert.rejects(
    () =>
      misc.execute(
        { task: "总结", material: "-----BEGIN PRIVATE KEY-----\nabc" },
        { sessionID: "ses_test" },
      ),
    /疑似包含密钥/,
  );

  // 6) 缺少 key：明确报错，不偷偷走本机模型
  await writeConfig({
    order: ["hy4"],
    providers: {
      hy4: {
        baseURL: "https://tokenhub.test/v1",
        model: "hy4-flash",
        apiKeyEnv: "NO_SUCH_HY4_KEY",
      },
    },
  });
  await assert.rejects(
    () => misc.execute({ task: "x", material: "y" }, { sessionID: "ses_test" }),
    /缺少 API Key/,
  );

  // 7) handoff 落盘 + 纯函数
  const ho = await handoff.execute(
    {
      next: "继续做插件验收",
      decisions: ["不做原地焚化"],
      files: ["plugins/ds-saver/index.js"],
      open: ["live 测试"],
    },
    { sessionID: "ses_test" },
  );
  assert.equal(ho.metadata.written, true);
  const body = await fs.readFile(ho.metadata.path, "utf8");
  assert.match(body, /继续做插件验收/);
  assert.match(body, /不做原地焚化/);

  // 8) tree：默认忽略、敏感/越界拒绝、截断
  const treeDir = path.join(tmp, "tree-fixture");
  await fs.mkdir(path.join(treeDir, "src"), { recursive: true });
  await fs.mkdir(path.join(treeDir, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(treeDir, "a.js"), "needle alpha\nsecond line\n");
  await fs.writeFile(path.join(treeDir, "src", "b.md"), "needle beta\n");
  await fs.writeFile(path.join(treeDir, "node_modules", "ignored.js"), "needle ignored\n");
  await fs.writeFile(path.join(treeDir, ".env"), "needle secret\n");

  const treeOut = await tree.execute(
    { path: "tree-fixture", depth: 3, maxEntries: 20 },
    { sessionID: "ses_test" },
  );
  assert.match(treeOut.content, /tree-fixture\//);
  assert.match(treeOut.content, /a\.js/);
  assert.match(treeOut.content, /src\//);
  assert.match(treeOut.content, /b\.md/);
  assert.doesNotMatch(treeOut.content, /node_modules/);
  assert.doesNotMatch(treeOut.content, /\.env/);
  assert.equal(treeOut.metadata.truncated, false);

  const treeTruncated = await tree.execute(
    { path: "tree-fixture", maxEntries: 1 },
    { sessionID: "ses_test" },
  );
  assert.match(treeTruncated.content, /已截断/);
  assert.equal(treeTruncated.metadata.truncated, true);

  await assert.rejects(
    () => tree.execute({ path: "03-密钥" }, { sessionID: "ses_test" }),
    /拒绝读取敏感路径/,
  );
  await assert.rejects(
    () => tree.execute({ path: "../outside" }, { sessionID: "ses_test" }),
    /拒绝越界路径/,
  );

  // 9) rag：命中、忽略敏感/依赖目录、include、命令失败回退
  const ragOut = await rag.execute(
    { query: "needle", path: "tree-fixture", topK: 5 },
    { sessionID: "ses_test" },
  );
  assert.match(ragOut.content, /a\.js:1:/);
  assert.match(ragOut.content, /src\/b\.md:1:/);
  assert.doesNotMatch(ragOut.content, /node_modules/);
  assert.doesNotMatch(ragOut.content, /\.env/);
  assert.ok(ragOut.metadata.hits >= 2);
  assert.equal(ragOut.metadata.engine, "builtin");

  const ragInclude = await rag.execute(
    { query: "needle beta", path: "tree-fixture", include: "*.md" },
    { sessionID: "ses_test" },
  );
  assert.match(ragInclude.content, /src\/b\.md:1:/);
  assert.doesNotMatch(ragInclude.content, /a\.js/);

  await assert.rejects(
    () => rag.execute({ query: "needle", path: "03-密钥" }, { sessionID: "ses_test" }),
    /拒绝读取敏感路径/,
  );

  process.env.DS_SAVER_RAG_CMD = "/nonexistent/ds-saver-rag";
  const ragFallback = await rag.execute(
    { query: "needle", path: "tree-fixture" },
    { sessionID: "ses_test" },
  );
  delete process.env.DS_SAVER_RAG_CMD;
  assert.equal(ragFallback.metadata.engine, "builtin");
  assert.match(ragFallback.content, /a\.js:1:/);

  assert.deepEqual(__test.parseReadRequest('{"read":["a.md","b.md"]}'), [
    "a.md",
    "b.md",
  ]);
  assert.equal(__test.parseReadRequest("最终结论"), null);
  assert.equal(__test.capLines("a\n\nb\nc", 2), "a\nb");
  assert.equal(__test.slugify("Hello, World!"), "hello-world");
  assert.deepEqual(__test.OFFICIAL.hy4.model, "hy4-flash");
  assert.deepEqual(__test.OFFICIAL.mimo.model, "mimo-v2.6-flash");
  assert.deepEqual(__test.OFFICIAL.qwen.model, "qwen3.8-flash");

  console.log("smoke: 9 组断言全部通过");
} finally {
  delete global.fetch;
  await fs.rm(tmp, { recursive: true, force: true });
}
