// src-react/domains/ai/orchestration/components/AddNodeMenu.tsx
/**
 * 添加节点菜单（参照 Coze）：主按钮 + Popover 分类面板——顶部搜索
 * 过滤 + 分组网格（每项图标/名称/一句话描述）。替代旧的三个快捷钮
 * +「更多节点」平铺下拉（19 种节点已不可平铺）。
 */
import { createContext, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bell,
  Braces,
  Database,
  DatabaseZap,
  FileSpreadsheet,
  GitMerge,
  Compass,
  Table,
  Variable,
  Sigma,
  Mail,
  FilePen,
  FileText,
  GitBranch,
  Globe,
  Hourglass,
  ImageIcon,
  Library,
  Play,
  Plus,
  Repeat,
  ScanText,
  Search,
  Sparkles,
  Terminal,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { NodeKind } from "../lib/graph-editor-model";

/** kind → 现有扁平 i18n key（kindLlm 等）+ 一句话描述 key */
const KIND_NAME_KEY: Record<NodeKind, string> = {
  start: "chat:orchestration.editor.kindStart",
  llm: "chat:orchestration.editor.kindLlm",
  code: "chat:orchestration.editor.kindCode",
  http: "chat:orchestration.editor.kindHttp",
  fileRead: "chat:orchestration.editor.kindFileRead",
  notify: "chat:orchestration.editor.kindNotify",
  subflow: "chat:orchestration.editor.kindSubflow",
  iterate: "chat:orchestration.editor.kindIterate",
  librarySearch: "chat:orchestration.editor.kindLibrarySearch",
  jsonParse: "chat:orchestration.editor.kindJsonParse",
  jsonStringify: "chat:orchestration.editor.kindJsonStringify",
  condition: "chat:orchestration.editor.kindCondition",
  intent: "chat:orchestration.editor.kindIntent",
  fileWrite: "chat:orchestration.editor.kindFileWrite",
  docExtract: "chat:orchestration.editor.kindDocExtract",
  imageGen: "chat:orchestration.editor.kindImageGen",
  delay: "chat:orchestration.editor.kindDelay",
  vectorize: "chat:orchestration.editor.kindVectorize",
  vectorSearch: "chat:orchestration.editor.kindVectorSearch",
  database: "chat:orchestration.editor.kindDatabase",
  excelRead: "chat:orchestration.editor.kindExcelRead",
  excelWrite: "chat:orchestration.editor.kindExcelWrite",
  csvRead: "chat:orchestration.editor.kindCsvRead",
  csvWrite: "chat:orchestration.editor.kindCsvWrite",
  variable: "chat:orchestration.editor.kindVariable",
  aggregate: "chat:orchestration.editor.kindAggregate",
  email: "chat:orchestration.editor.kindEmail",
  merge: "chat:orchestration.editor.kindMerge",
};

const descKey = (kind: NodeKind) =>
  `chat:orchestration.editor.nodeDesc.${kind}`;

/** 图内是否已有 start 节点：start 菜单项唯一性禁用依据。AddNodeMenu 深藏
 *  GraphCanvas Panel 内（props 穿透须改组件链），经 context 由持有图状态
 *  的 GraphEditorView 注入 */
export const GraphHasStartContext = createContext(false);

/** 分组定义（展示顺序即渲染顺序；descI18n 为一句话说明） */
const GROUPS: Array<{
  key: string;
  kinds: Array<{ kind: NodeKind; icon: LucideIcon }>;
}> = [
  {
    key: "model",
    kinds: [
      { kind: "llm", icon: Sparkles },
      { kind: "imageGen", icon: ImageIcon },
    ],
  },
  {
    key: "tool",
    kinds: [
      { kind: "code", icon: Terminal },
      { kind: "http", icon: Globe },
      { kind: "email", icon: Mail },
      { kind: "librarySearch", icon: Library },
    ],
  },
  {
    key: "flow",
    kinds: [
      // start 居首：入口节点优先补（旧图迁移场景），已有即禁用
      { kind: "start", icon: Play },
      { kind: "condition", icon: GitBranch },
      { kind: "intent", icon: Compass },
      { kind: "iterate", icon: Repeat },
      { kind: "subflow", icon: Workflow },
      { kind: "delay", icon: Hourglass },
      { kind: "merge", icon: GitMerge },
    ],
  },
  {
    key: "data",
    kinds: [
      { kind: "jsonParse", icon: Braces },
      { kind: "jsonStringify", icon: Braces },
      { kind: "vectorize", icon: DatabaseZap },
      { kind: "vectorSearch", icon: Database },
      { kind: "database", icon: Database },
    ],
  },
  {
    key: "io",
    kinds: [
      { kind: "fileRead", icon: FileText },
      { kind: "fileWrite", icon: FilePen },
      { kind: "docExtract", icon: ScanText },
      { kind: "notify", icon: Bell },
      { kind: "excelRead", icon: FileSpreadsheet },
      { kind: "excelWrite", icon: FileSpreadsheet },
      { kind: "csvRead", icon: Table },
      { kind: "csvWrite", icon: Table },
      { kind: "variable", icon: Variable },
      { kind: "aggregate", icon: Sigma },
    ],
  },
];

export default function AddNodeMenu({
  onAddNode,
}: {
  onAddNode: (kind: NodeKind) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const hasStart = useContext(GraphHasStartContext);

  const keyword = search.trim().toLowerCase();
  const groups = useMemo(() => {
    if (keyword === "") {
      return GROUPS;
    }
    // 搜索按名称/描述本地化文本过滤（空分组隐藏）
    return GROUPS.map((group) => ({
      ...group,
      kinds: group.kinds.filter(({ kind }) => {
        const name = t(KIND_NAME_KEY[kind]).toLowerCase();
        const desc = t(descKey(kind)).toLowerCase();
        return name.includes(keyword) || desc.includes(keyword);
      }),
    })).filter((group) => group.kinds.length > 0);
  }, [keyword, t]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" className="h-7 gap-1 px-3">
          <Plus className="h-4 w-4" />
          {t("chat:orchestration.editor.addNode")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[380px] rounded-lg border border-border/50 p-2 shadow-lg"
      >
        {/* 搜索框：名称/描述过滤 */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            className="h-8 pl-7 text-xs"
            placeholder={t("chat:orchestration.editor.addNodeSearch")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="mt-2 max-h-[380px] overflow-y-auto">
          {groups.map((group) => (
            <div key={group.key} className="mb-1">
              <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                {t(`chat:orchestration.editor.nodeGroup.${group.key}`)}
              </p>
              <div className="grid grid-cols-2 gap-1">
                {group.kinds.map(({ kind, icon: Icon }) => {
                  // start 为图级唯一入口：已有即禁用（点击/拖拽均不可再加）
                  const disabled = kind === "start" && hasStart;
                  return (
                    <button
                      key={kind}
                      type="button"
                      draggable={!disabled}
                      onDragStart={(event) => {
                        // 画布 onDrop 转 flow 坐标落点；点击添加走 onClick
                        event.dataTransfer.setData(
                          "application/tianshu-node-kind",
                          kind,
                        );
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      disabled={disabled}
                      className="flex cursor-grab items-start gap-2 rounded-lg p-2 text-left transition-colors hover:bg-primary-subtle disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      onClick={() => {
                        onAddNode(kind);
                        setOpen(false);
                        setSearch("");
                      }}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium text-foreground">
                          {t(KIND_NAME_KEY[kind])}
                        </span>
                        <span className="truncate text-[10px] text-muted-foreground">
                          {t(descKey(kind))}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("chat:orchestration.editor.addNodeNoMatch")}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
