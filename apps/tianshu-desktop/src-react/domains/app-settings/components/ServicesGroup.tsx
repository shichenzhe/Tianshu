/**
 * 对外服务页：本机对外监听面单页归置——Webhook 入站（所有工作流共用
 * 端口，改后热重绑、被占回滚）与本机被控面（远程端遥控本机的 HTTP/WS
 * 服务，控制端视角常驻配置卡，组件复用自 server 域）同类同页。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import LocalFaceCard from "@/domains/ai/server/components/LocalFaceCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import SettingsGroup from "./SettingsGroup";
import { SettingsApi } from "../api/settings.api";

/** Webhook 端口块：装载当前生效值，保存按钮提交（试绑失败后端回滚报错） */
function WebhookPortGroup() {
  const { t } = useTranslation(["settings"]);
  const [port, setPort] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void SettingsApi.getWebhookPort().then((p) => setPort(String(p)));
  }, []);

  async function save() {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65_536) {
      toast.error(t("settings:general.webhookPortInvalid"));
      return;
    }
    setSaving(true);
    try {
      const bound = await SettingsApi.setWebhookPort(parsed);
      setPort(String(bound));
      toast.success(t("settings:general.webhookPortSaved"));
    } catch (e) {
      toast.error(
        t("settings:general.webhookPortFailed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsGroup title={t("settings:groups.webhook")}>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-sm font-normal">
            {t("settings:general.webhookPort")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              className="h-8 w-24 text-right font-normal"
              type="number"
              min={1}
              max={65_535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              aria-label={t("settings:general.webhookPort")}
            />
            <Button
              variant="outline"
              size="sm"
              className="font-normal hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              disabled={saving}
              onClick={() => void save()}
            >
              {t("settings:general.webhookPortSave")}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings:general.webhookPortHint")}
        </p>
      </div>
    </SettingsGroup>
  );
}

export default function ServicesGroup() {
  const { t } = useTranslation(["settings"]);
  return (
    <>
      <WebhookPortGroup />
      <SettingsGroup title={t("settings:groups.localFace")}>
        <LocalFaceCard />
      </SettingsGroup>
    </>
  );
}
