/**
 * 资料库（占位骨架）：搜索框 + 最近/本地产物 chips + 我的资料/团队空间可折叠分组。
 * 内容管理为占位（按钮 toast 开发中），数据接入后续迭代。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  Plus,
  Share2,
} from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LibraryView() {
  const { t } = useTranslation(["chat", "common"]);
  const [keyword, setKeyword] = useState("");
  const [mineOpen, setMineOpen] = useState(true);
  const [teamOpen, setTeamOpen] = useState(true);

  const comingSoon = () => {
    toast.info(t("chat:task.comingSoon"));
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto p-4">
      <PageTitle title={t("chat:library.title")}>
        <Button
          variant="ghost"
          size="sm"
          className="text-white/90 hover:bg-white/20 hover:text-white"
          onClick={comingSoon}
          aria-label={t("chat:library.export")}
        >
          <Share2 className="h-4 w-4" />
        </Button>
      </PageTitle>

      <div className="flex items-center gap-2 py-3">
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("chat:library.searchPlaceholder")}
          className="max-w-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={comingSoon}
        >
          <Clock className="mr-1 h-4 w-4" />
          {t("chat:library.recent")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={comingSoon}
        >
          <FolderOpen className="mr-1 h-4 w-4" />
          {t("chat:library.localOutputs")}
        </Button>
      </div>

      <LibraryGroup
        open={mineOpen}
        title={t("chat:library.mine")}
        onToggle={() => setMineOpen((open) => !open)}
        onAdd={comingSoon}
        emptyText={t("chat:library.empty")}
      />
      <LibraryGroup
        open={teamOpen}
        title={t("chat:library.team")}
        onToggle={() => setTeamOpen((open) => !open)}
        onAdd={comingSoon}
        emptyText={t("chat:library.empty")}
      />
    </div>
  );
}

interface LibraryGroupProps {
  open: boolean;
  title: string;
  onToggle: () => void;
  onAdd: () => void;
  emptyText: string;
}

/** 资料分组：标题行（折叠钮 + + 按钮）+ 空态列表 */
function LibraryGroup({
  open,
  title,
  onToggle,
  onAdd,
  emptyText,
}: LibraryGroupProps) {
  const { t } = useTranslation(["chat", "common"]);

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1 py-1 text-sm font-medium text-foreground/90 hover:bg-primary-subtle/60"
          onClick={onToggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
          onClick={onAdd}
          aria-label={t("chat:library.add")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
      {open && (
        <div className="ml-2 mt-1 rounded-md border border-border/50 p-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="h-4 w-4" />
            {emptyText}
          </p>
        </div>
      )}
    </div>
  );
}
