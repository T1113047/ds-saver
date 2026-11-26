/**
 * DeepSeek Harness (DSH) 适配层。
 *
 * 与 OpenCode 入口（../index.js）共享纯逻辑，只做注册映射：
 *   OpenCode: Plugin.define({ id, setup }) + ctx.tool.transform
 *   DSH:      具名 name / inject / apply + ctx.tools.register(definition)
 *
 * 注意：这里**不 import** `@deepseek-ai/dsh-tools`。第三方插件通常以
 * `link:` / 本地目录安装，Node 不会从 DSH 安装目录解析 peerDependency，
 * 直接 import 会在全新 DSH 上报 "Cannot find package
 * '@deepseek-ai/dsh-tools'"。`defineDshTool` 是等价的本地实现：
 * 把参数 DSL 编译成原始 JSON Schema，并在 execute 前校验参数。
 */

import { core } from "../index.js";

/** 把作者侧 value schema DSL 编译成 DSH 接受的原始 JSON Schema 子集。 */
function compileValueSchema(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("ds-saver: value schema must be an object");
  }

  const out = {};
  for (const key of ["title", "description", "default", "examples"]) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }

  switch (spec.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      out.type = spec.type;
      if (spec.enum !== undefined) out.enum = [...spec.enum];
      if (spec.const !== undefined) out.const = spec.const;
      return out;
    case "null":
      out.type = "null";
      return out;
    case "array":
      out.type = "array";
      out.items = spec.items ? compileValueSchema(spec.items) : {};
      return out;
    case "object": {
      out.type = "object";
      const properties = {};
      for (const [name, child] of Object.entries(spec.properties || {})) {
        properties[name] = compileValueSchema(child);
      }
      out.properties = properties;
      out.additionalProperties = spec.additionalProperties === true;
      return out;
    }
    case "json":
      // 作者侧仅标注任意 JSON；线上 schema 用空约束表示。
      return out;
    case "oneOf":
      if (!Array.isArray(spec.oneOf) || spec.oneOf.length < 2) {
        throw new Error("ds-saver: oneOf requires at least two branches");
      }
      out.oneOf = spec.oneOf.map(compileValueSchema);
      return out;
    default:
      throw new Error(`ds-saver: unsupported schema type ${JSON.stringify(spec.type)}`);
  }
}

/** 参数 DSL → 隐式 object 根 JSON Schema；`required: true` 收集为 required 数组。 */
function compileParameters(parameters) {
  const properties = {};
  const required = [];
  for (const [name, spec] of Object.entries(parameters || {})) {
    const { required: isRequired, ...valueSpec } = spec;
    properties[name] = compileValueSchema(valueSpec);
    if (isRequired === true) required.push(name);
  }
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** 校验模型参数，返回违规列表；空数组表示通过。 */
function validateValue(schema, value, path) {
  if (schema.const !== undefined) {
    if (value !== schema.const) return [`${path} must equal const`];
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    return [`${path} must be one of the declared values`];
  }

  const type = schema.type;
  if (type === undefined) return [];
  const ok =
    type === "string" ? typeof value === "string"
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
        : type === "integer" ? Number.isInteger(value)
          : type === "boolean" ? typeof value === "boolean"
            : type === "null" ? value === null
              : type === "array" ? Array.isArray(value)
                : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
                  : true;
  if (!ok) return [`${path || "arguments"} must be ${type}`];

  if (type === "array" && schema.items) {
    const violations = [];
    value.forEach((item, index) => {
      violations.push(...validateValue(schema.items, item, `${path}[${index}]`));
    });
    return violations;
  }

  if (type === "object") {
    const violations = [];
    for (const key of schema.required || []) {
      if (!(key in value)) violations.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) violations.push(...validateValue(child, value[key], `${path}.${key}`));
    }
    return violations;
  }

  return [];
}

/**
 * 等价于 `@deepseek-ai/dsh-tools` 的 `defineTool`（本项目用到的子集）：
 * 编译参数/输出 schema、校验参数、返回注册就绪的 definition。
 */
function defineDshTool(options) {
  const parameters = compileParameters(options.parameters);
  const outputSchema = compileValueSchema(options.output.schema);
  const render = options.output.render;

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return render(args, value);
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, "");
      if (violations.length > 0) {
        const error = new Error(`invalid arguments: ${violations.join("; ")}`);
        error.name = "ToolArgsError";
        throw error;
      }
      return options.execute(args || {}, exec);
    },
  };
}

function assertNotAborted(exec) {
  if (exec?.signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

function textTool(name, description, parameters, run) {
  return defineDshTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      assertNotAborted(exec);
      const result = await run(args || {});
      assertNotAborted(exec);
      return typeof result === "string" ? result : String(result?.content ?? "");
    },
  });
}

function workspaceRoot() {
  return process.env.DS_SAVER_WORKSPACE || process.cwd();
}

export const name = "ds-saver";
export const inject = ["tools"];

export function apply(ctx) {
  const root = workspaceRoot();
  const tree = core.treeTool(root);
  const rag = core.ragTool(root);
  const misc = core.miscTool(root);
  const handoff = core.handoffTool();

  ctx.tools.register(
    textTool(
      "tree",
      "只读输出紧凑目录树；默认忽略 .git/node_modules/构建产物，敏感路径返回空。",
      {
        path: { type: "string", description: "目录，默认 cwd" },
        depth: { type: "number", description: "默认 3，上限 8" },
        maxEntries: { type: "number", description: "默认 400，上限 2000" },
      },
      (args) => tree.execute(args),
    ),
  );

  ctx.tools.register(
    textTool(
      "rag",
      "轻量本地检索：优先外部命令 DS_SAVER_RAG_CMD，否则内置行匹配。",
      {
        query: { type: "string", required: true, description: "检索词，空格分词" },
        path: { type: "string", description: "目录或文件，默认 cwd" },
        topK: { type: "number", description: "默认 8，上限 30" },
        include: { type: "string", description: "可选 glob，如 *.js" },
        filter: { type: "boolean", description: "true 时先用便宜模型筛候选再注入，默认 false" },
        filter_topK: { type: "number", description: "筛选后注入条数，默认 5，上限 8" },
        model: { type: "string", description: "筛选模型：auto | hy4 | mimo | qwen | provider/model" },
      },
      (args) => rag.execute(args),
    ),
  );

  ctx.tools.register(
    textTool(
      "misc",
      "用便宜官方模型筛选材料/日志/文档，只回短结论。DSH 版不支持 paths 参数，请把内容放进 material。",
      {
        task: { type: "string", required: true, description: "要筛选或回答的问题" },
        material: { type: "string", description: "直接提供的材料" },
        mode: { type: "string", description: "filter（默认）或 agent（无 paths 时等同 filter）" },
        max_lines: { type: "number", description: "默认 20，上限 80" },
        max_input_chars: { type: "number", description: "默认 24000" },
        model: { type: "string", description: "auto | hy4 | mimo | qwen | provider/model" },
        timeout_sec: { type: "number", description: "默认 60" },
      },
      (args) => misc.execute(args),
    ),
  );

  ctx.tools.register(
    textTool(
      "handoff",
      "生成紧凑交接文档并落盘（默认写入 DS_SAVER_HANDOFF_DIR 或 cwd/.handoff）。",
      {
        next: { type: "string", required: true, description: "下一步要做什么" },
        decisions: { type: "string", description: "关键决定，换行分隔" },
        files: { type: "string", description: "涉及文件，换行分隔" },
        open: { type: "string", description: "未决问题，换行分隔" },
        notes: { type: "string", description: "备注" },
        write: { type: "boolean", description: "是否落盘，默认 true" },
      },
      (args) => {
        const lines = (v) =>
          typeof v === "string" && v.trim()
            ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
            : undefined;
        return handoff.execute({
          ...args,
          decisions: lines(args.decisions),
          files: lines(args.files),
          open: lines(args.open),
        });
      },
    ),
  );
}
