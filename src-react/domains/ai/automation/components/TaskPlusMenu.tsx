/**
 * 任务输入卡 ＋菜单:PlusMenu 子集——文件/技能/MCP + 插入变量;
 * 剔除模式三态与专家项(会话语义)。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Braces, FilePlus, Plug, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { invoke } from "@/lib/ipc";
import SkillImportDialog from "../../skills/components/SkillImportDialog";
import SkillSubMenu from "../../chat/components/skill-sub-menu";

interface PickedFile {
  path: string;
  content?: string;
  error?: string;
}

export interface TaskPlusMenuProps {
  onPickPaths: (paths: string[]) => void;
  onOpenMcp: () => void;
  onInsertVariable: (token: string) => void;
}

/** 插入变量三件套:插入 token / i18n 键 / 插值参数名(值形如「日期 {{date}}」) */
const VARIABLES = [
  { token: "{{date}}", key: "varDate", param: "date" },
  { token: "{{weekday}}", key: "varWeekday", param: "weekday" },
  { token: "{{time}}", key: "varTime", param: "time" },
] as const;

export default function TaskPlusMenu({
  onPickPaths,
  onOpenMcp,
  onInsertVariable,
}: TaskPlusMenuProps) {
  const { t } = useTranslation(["chat"]);
  const [importOpen, setImportOpen] = useState(false);

  const handleAddFile = async () => {
    let picked: PickedFile[];
    try {
      picked = await invoke<PickedFile[]>("file:pickAndRead");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    const paths: string[] = [];
    for (const file of picked) {
      if (file.error !== undefined) {
        toast.error(
          t("chat:attach.readFailed", { path: file.path, reason: file.error }),
        );
      } else {
        paths.push(file.path);
      }
    }
    if (paths.length > 0) {
      onPickPaths(paths);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("chat:plus.title")}
            className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-52 border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem onClick={() => void handleAddFile()}>
            <FilePlus />
            {t("chat:plus.addFile")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <SkillSubMenu onImport={() => setImportOpen(true)} />
          <DropdownMenuSeparator />
          {VARIABLES.map(({ token, key, param }) => (
            <DropdownMenuItem
              key={token}
              onClick={() => onInsertVariable(token)}
            >
              <Braces />
              {t(`chat:automation.create.${key}`, { [param]: token })}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenMcp}>
            <Plug />
            {t("chat:plus.connector")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SkillImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
