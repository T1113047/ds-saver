/**
 * DeepSeek Harness (DSH) 适配层。
 *
 * 与 OpenCode 入口（../index.js）共享纯逻辑，只做注册映射：
 *   OpenCode: Plugin.define({ id, setup }) + ctx.tool.transform
 *   DSH:      具名 name / inject / apply + ctx.tools.register(defineTool)
 *
 * 本文件只应在 DSH 环境加载；OpenCode 不会读取 exports["./dsh"]。
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { core } from "../index.js";

const ROOT = process.env.DS_SAVER_WORKSPACE || process.cwd();

const textOutput = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

function assertNotAborted(exec) {
  if (exec?.signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

function toText(name, description, parameters, run) {
  return defineTool({
    name,
    description,
    parameters,
    output: textOutput,
    async execute(args, exec) {
      assertNotAborted(exec);
      const result = await run(args || {});
      assertNotAborted(exec);
      return typeof result === "string" ? result : String(result?.content ?? "");
    },
  });
}

const tree = core.treeTool(ROOT);
const rag = core.ragTool(ROOT);
const misc = core.miscTool(ROOT);
const handoff = core.handoffTool();

export const name = "ds-saver";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(
    toText(
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
    toText(
      "rag",
      "轻量本地检索：优先外部命令 DS_SAVER_RAG_CMD，否则内置行匹配。",
      {
        query: { type: "string", required: true, description: "检索词，空格分词" },
        path: { type: "string", description: "目录或文件，默认 cwd" },
        topK: { type: "number", description: "默认 8，上限 30" },
        include: { type: "string", description: "可选 glob，如 *.js" },
      },
      (args) => rag.execute(args),
    ),
  );

  ctx.tools.register(
    toText(
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
    toText(
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
