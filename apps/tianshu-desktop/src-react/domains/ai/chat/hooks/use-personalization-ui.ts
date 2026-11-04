/**
 * 聊天界面读取个性化 UI 开关（spec §5.4）：与设置页共享
 * ["personalization"] 查询缓存（staleTime Infinity），设置页保存后
 * invalidate → 下一次流式渲染即刻生效。查询未就绪回退默认值。
 */
import { useQuery } from "@tanstack/react-query";

import { SettingsApi } from "@/domains/app-settings/api/settings.api";
import {
  parseBoolOption,
  toOptionMap,
} from "@/domains/app-settings/model/app-options";
import { PERSONALIZATION_KEYS } from "@/domains/app-settings/model/personalization-options";

export interface PersonalizationUiFlags {
  welcomeLoading: boolean;
  fileChangeDetails: boolean;
}

const DEFAULT_FLAGS: PersonalizationUiFlags = {
  welcomeLoading: true,
  fileChangeDetails: false,
};

export function usePersonalizationUi(): PersonalizationUiFlags {
  const { data } = useQuery({
    queryKey: ["personalization"],
    queryFn: () => SettingsApi.getAll(),
    staleTime: Infinity,
    select: (items): PersonalizationUiFlags => {
      const map = toOptionMap(items);
      return {
        welcomeLoading: parseBoolOption(
          map[PERSONALIZATION_KEYS.welcomeLoading],
          DEFAULT_FLAGS.welcomeLoading,
        ),
        fileChangeDetails: parseBoolOption(
          map[PERSONALIZATION_KEYS.fileChangeDetails],
          DEFAULT_FLAGS.fileChangeDetails,
        ),
      };
    },
  });
  return data ?? DEFAULT_FLAGS;
}
