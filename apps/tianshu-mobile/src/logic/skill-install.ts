// SkillHub 安装链（市场区 + 详情页共用，抽离避免双份）：install →
// null 读 installError toast 服务端错码 / conflict 弹 Alert 覆盖确认 /
// installed toast 成功。i18n 实例直引（stream/orchestration store 同先例）。
import { Alert } from "react-native";

import i18n from "../i18n";
import { toast } from "../lib/toast-bus";
import { useSkillsStore } from "../store/skills.store";

export async function runSkillInstall(
  slug: string,
  overwrite = false,
): Promise<void> {
  const result = await useSkillsStore.getState().install(slug, overwrite);
  if (result === null) {
    const code = useSkillsStore.getState().installError;
    toast.error(
      i18n.t([`skills:error.${code ?? ""}`, "skills:error.fallback"], {
        message: code ?? "",
      }),
    );
    return;
  }
  if (result.status === "conflict") {
    Alert.alert(
      i18n.t("skills:conflictTitle"),
      i18n.t("skills:conflictMessage", { name: result.name }),
      [
        { text: i18n.t("common:cancel"), style: "cancel" },
        {
          text: i18n.t("skills:overwrite"),
          onPress: () => void runSkillInstall(slug, true),
        },
      ],
    );
    return;
  }
  toast.info(i18n.t("skills:installSuccess", { name: result.record.name }));
}
