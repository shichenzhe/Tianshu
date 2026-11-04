/**
 * 工作流 bundle（批量导出/回导）：单图包裹 doc（exportWorkflow 同款
 * kind/version 形态）聚合成 bundle、bundle 解析与名称去重的纯函数——
 * dialog/fs 与 prisma 均在 repo 层，本模块零依赖可测。
 */

/** 单图导出项（repo 查库产出：graphJson 为库内 JSON 字符串） */
export interface BundleSourceItem {
  name: string;
  description?: string;
  graphJson: string;
}

/** bundle 内的单图 doc（与 exportWorkflow 落盘的单图文件同构） */
export interface BundleWorkflowDoc {
  kind: "tianshu-workflow";
  version: 1;
  name: string;
  description: string;
  graphJson: object;
}

export interface WorkflowBundleDoc {
  kind: "tianshu-workflow-bundle";
  version: 1;
  workflows: BundleWorkflowDoc[];
}

/** 解析产出项（graphJson 已是对象，repo 侧直接进 validate/create） */
export interface ParsedBundleItem {
  name: string;
  description: string;
  graphJson: object;
}

export type ParseBundleResult =
  | {
      ok: true;
      items: ParsedBundleItem[];
      failed: Array<{ name: string; reason: string }>;
    }
  | { ok: false; reason: string };

/** 组装 bundle：graphJson 字符串转对象，非法项跳过（库里不该发生，容错） */
export function buildWorkflowBundle(
  items: BundleSourceItem[],
): WorkflowBundleDoc {
  const workflows: BundleWorkflowDoc[] = [];
  for (const item of items) {
    try {
      const graph = JSON.parse(item.graphJson) as object;
      if (graph === null || typeof graph !== "object" || Array.isArray(graph)) {
        continue;
      }
      workflows.push({
        kind: "tianshu-workflow",
        version: 1,
        name: item.name,
        description: item.description ?? "",
        graphJson: graph,
      });
    } catch {
      // 非法 JSON 跳过（导出源为库内已验证数据，此处仅兜底）
    }
  }
  return { kind: "tianshu-workflow-bundle", version: 1, workflows };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析 bundle：结构不符 ok:false；项内 graphJson 缺失/非对象进 failed */
export function parseWorkflowBundle(raw: unknown): ParseBundleResult {
  if (!isPlainObject(raw) || raw.kind !== "tianshu-workflow-bundle") {
    return { ok: false, reason: "文件不是工作流集合（缺少 bundle 标识）" };
  }
  if (!Array.isArray(raw.workflows)) {
    return { ok: false, reason: "workflows 不是数组" };
  }
  const items: ParsedBundleItem[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const entry of raw.workflows) {
    if (!isPlainObject(entry)) {
      failed.push({ name: "(unknown)", reason: "条目不是对象" });
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name : "";
    if (name === "") {
      // 本应用导出的 bundle 必有名；缺名视为无效项（repo 无文件名可兜底）
      failed.push({ name: "(unknown)", reason: "缺少名称" });
      continue;
    }
    if (!isPlainObject(entry.graphJson)) {
      failed.push({ name, reason: "graphJson 缺失或不是对象" });
      continue;
    }
    items.push({
      name,
      description:
        typeof entry.description === "string" ? entry.description : "",
      graphJson: entry.graphJson,
    });
  }
  return { ok: true, items, failed };
}

/** 导入名称去重：冲突追加 " (n)" 递增（n 从 2 起），并回填 used */
export function dedupeName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  let n = 2;
  while (used.has(`${name} (${n})`)) {
    n += 1;
  }
  const deduped = `${name} (${n})`;
  used.add(deduped);
  return deduped;
}
