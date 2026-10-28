/**
 * 数据源编辑弹窗（新增/编辑共用）：name/host/port/database/username/
 * password/ssl 表单。编辑态 password 留空 = 不修改（回执只带 hasPassword，
 * 明文只写不读）；端口缺省 5432。提交校验走主进程 repo（中文文案直显）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import DataSourceApi, {
  type DataSourceRecord,
} from "../../api/data-source.api";
import { mapIpcError } from "../../chat/lib/error-message";

interface DataSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑目标（缺省 = 新增） */
  editing?: DataSourceRecord;
  onSaved: (id: number) => void;
}

interface FormState {
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  host: "",
  port: "5432",
  database: "",
  username: "",
  password: "",
  ssl: false,
};

export default function DataSourceDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: DataSourceDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setForm(
      editing
        ? {
            name: editing.name,
            host: editing.host,
            port: String(editing.port),
            database: editing.database,
            username: editing.username,
            password: "",
            ssl: editing.ssl,
          }
        : EMPTY_FORM,
    );
  }, [open, editing]);

  const patch = (partial: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...partial }));

  const handleSave = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      const port = form.port.trim() === "" ? undefined : Number(form.port);
      const record = editing
        ? await DataSourceApi.update({
            id: editing.id,
            name: form.name.trim(),
            host: form.host.trim(),
            port,
            database: form.database.trim(),
            username: form.username.trim(),
            // 编辑留空 = 不修改（undefined 不上送）；新增留空 = null 由
            // 主进程落 null
            password:
              editing && form.password === ""
                ? undefined
                : form.password === ""
                  ? null
                  : form.password,
            ssl: form.ssl,
          })
        : await DataSourceApi.create({
            name: form.name.trim(),
            host: form.host.trim(),
            port,
            database: form.database.trim(),
            username: form.username.trim(),
            password: form.password === "" ? undefined : form.password,
            ssl: form.ssl,
          });
      onSaved(record.id);
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSaving(false);
    }
  };

  const fields: Array<{
    key: keyof Omit<FormState, "ssl">;
    type?: string;
  }> = [
    { key: "name" },
    { key: "host" },
    { key: "port", type: "number" },
    { key: "database" },
    { key: "username" },
    { key: "password", type: "password" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("ai:dataSource.editTitle")
              : t("ai:dataSource.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("ai:dataSource.formTip")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          {fields.map(({ key, type }) => (
            <div key={key} className="grid gap-1.5">
              <Label htmlFor={`ds-${key}`}>{t(`ai:dataSource.${key}`)}</Label>
              <Input
                id={`ds-${key}`}
                type={type ?? "text"}
                value={form[key]}
                onChange={(e) => patch({ [key]: e.target.value })}
                placeholder={
                  key === "password" && editing
                    ? t("ai:dataSource.passwordKeep")
                    : undefined
                }
              />
            </div>
          ))}
          <div className="flex items-center justify-between rounded-md border border-border/50 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm text-foreground">
                {t("ai:dataSource.ssl")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("ai:dataSource.sslTip")}
              </p>
            </div>
            <Switch
              checked={form.ssl}
              onCheckedChange={(checked) => patch({ ssl: checked })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
