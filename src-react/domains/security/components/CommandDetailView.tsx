/**
 * 命令安全二级页（SP2 spec §7）：三名单 CRUD（PRD 附录交互——添加行
 * → 输入框 → 对勾/叉号）+ 优先级说明 + 重置为默认。
 * CRUD 走 setConfig 整组替换；黑名单仅接受裸程序名。
 * 输入框 Escape 阻止冒泡——避免冒泡到外层设置 Dialog 误关整个对话框。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Check, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  CmdRule,
  SecurityConfig,
  SecurityConfigKey,
} from "../model/types";
import { SecurityApi } from "../api/security.api";

interface CommandDetailViewProps {
  config: SecurityConfig;
  onBack: () => void;
  onRulesChange: (config: SecurityConfig) => void;
}

/** 单个名单区块：标题/说明/列表/添加行（编辑态内联输入框） */
function RuleSection(props: {
  titleKey: string;
  descKey: string;
  placeholderKey: string;
  invalidKey: string;
  items: string[];
  validate: (raw: string) => string | null;
  onSave: (items: string[]) => Promise<void>;
}) {
  const { t } = useTranslation(["security"]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  /** 关闭内联编辑并清空草稿（取消/保存/重复静默关闭共用） */
  const closeEditor = () => {
    setEditing(false);
    setDraft("");
  };

  const add = async () => {
    const normalized = props.validate(draft);
    if (normalized === null) {
      toast.error(t(props.invalidKey));
      return;
    }
    if (props.items.some((it) => sameTokens(it, normalized))) {
      closeEditor();
      return;
    }
    await props.onSave([...props.items, normalized]);
    closeEditor();
  };

  const remove = async (item: string) => {
    await props.onSave(props.items.filter((it) => it !== item));
  };

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">{t(props.titleKey)}</h4>
        <p className="text-xs text-muted-foreground">{t(props.descKey)}</p>
      </div>
      <div className="space-y-1">
        {props.items.length === 0 && !editing && (
          <p className="text-xs text-muted-foreground">
            {t("security:commandDetail.empty")}
          </p>
        )}
        {props.items.map((item) => (
          <div key={item} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {item}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("security:commandDetail.remove")}
              onClick={() => void remove(item)}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        {editing ? (
          <div className="flex items-center gap-1">
            <Input
              autoFocus
              value={draft}
              placeholder={t(props.placeholderKey)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
                if (e.key === "Escape") {
                  // 仅取消本行编辑；不冒泡到外层设置 Dialog 的 Esc 关闭
                  e.stopPropagation();
                  closeEditor();
                }
              }}
              className="h-8"
            />
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("security:commandDetail.confirm")}
              onClick={() => void add()}
            >
              <Check size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("security:commandDetail.cancel")}
              onClick={closeEditor}
            >
              <X size={14} />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="hover:bg-primary-subtle hover:text-primary"
            onClick={() => setEditing(true)}
          >
            <Plus size={14} />
            {t("security:commandDetail.add")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** 黑名单输入校验：裸程序名（无路径分隔符/空白），原样返回或 null */
function validateProgram(raw: string): string | null {
  const v = raw.trim();
  return v !== "" && !/[/\\\s]/.test(v) ? v : null;
}

/** 空白分词归一化比较：避免多空格变体（"git  status" vs "git status"）存成重复规则 */
function sameTokens(a: string, b: string): boolean {
  return a.split(/\s+/).join(" ") === b.split(/\s+/).join(" ");
}

export default function CommandDetailView({
  config,
  onBack,
  onRulesChange,
}: CommandDetailViewProps) {
  const { t } = useTranslation(["security"]);
  const save = async (key: SecurityConfigKey, value: unknown) => {
    try {
      const saved = await SecurityApi.setConfig(key, value);
      onRulesChange(saved);
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const reset = async () => {
    try {
      onRulesChange(await SecurityApi.resetCommandRules());
      toast.success(t("security:commandDetail.resetDone"));
    } catch {
      toast.error(t("security:error.saveFailed"));
    }
  };
  const toRules = (items: string[]): CmdRule[] =>
    items.map((line) => ({ prefix: line.trim().split(/\s+/) }));
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft size={14} />
          {t("security:audit.back")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => void reset()}
        >
          <RotateCcw size={14} />
          {t("security:commandDetail.reset")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("security:commandDetail.priorityNote")}
      </p>
      <RuleSection
        titleKey="security:commandDetail.programBlacklist.title"
        descKey="security:commandDetail.programBlacklist.desc"
        placeholderKey="security:commandDetail.programBlacklist.placeholder"
        invalidKey="security:commandDetail.programBlacklist.invalid"
        items={config.programBlacklist}
        validate={validateProgram}
        onSave={(items) => save("programBlacklist", items)}
      />
      <RuleSection
        titleKey="security:commandDetail.allow.title"
        descKey="security:commandDetail.allow.desc"
        placeholderKey="security:commandDetail.allow.placeholder"
        invalidKey="security:commandDetail.invalidCommand"
        items={config.cmdAllow.map((r) => r.prefix.join(" "))}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("cmdAllow", toRules(items))}
      />
      <RuleSection
        titleKey="security:commandDetail.ask.title"
        descKey="security:commandDetail.ask.desc"
        placeholderKey="security:commandDetail.ask.placeholder"
        invalidKey="security:commandDetail.invalidCommand"
        items={config.cmdAsk.map((r) => r.prefix.join(" "))}
        validate={(raw) => (raw.trim() !== "" ? raw.trim() : null)}
        onSave={(items) => save("cmdAsk", toRules(items))}
      />
    </div>
  );
}
