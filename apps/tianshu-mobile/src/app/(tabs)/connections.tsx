import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Modal, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Plus, Radio } from "lucide-react-native";

import { ConnectionCard } from "@/components/ConnectionCard";
import { ConnectionForm } from "@/components/ConnectionForm";
import {
  useConnectionsStore,
  type ConnectionConfig,
} from "@/store/connections.store";
import { useThemeColors } from "@/store/theme";

/** 连接管理页（T12）：FlatList 列表 + 双模式 Modal 表单 + 六态徽章 + 激活切换 */
export default function ConnectionsScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const configs = useConnectionsStore((s) => s.configs);
  const [formVisible, setFormVisible] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | undefined>(
    undefined,
  );
  const [createMode, setCreateMode] = useState<"direct" | "relay">("direct");

  function openCreate(mode: "direct" | "relay") {
    setEditing(undefined);
    setCreateMode(mode);
    setFormVisible(true);
  }

  function openEdit(cfg: ConnectionConfig) {
    setEditing(cfg);
    setFormVisible(true);
  }

  function closeForm() {
    setFormVisible(false);
    setEditing(undefined);
  }

  return (
    <View className="flex-1 bg-grouped dark:bg-black">
      <View className="flex-row gap-3 border-b border-sep px-4 py-3 dark:border-[#545458A6]">
        <Pressable
          onPress={() => openCreate("direct")}
          className="flex-1 flex-row items-center justify-center gap-1 rounded-lg px-3 py-2.5"
          style={{ backgroundColor: colors.primary }}
        >
          <Plus size={14} color="#fff" />
          <Text className="text-sm text-white">
            {t("connections:addDirect")}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => openCreate("relay")}
          className="flex-1 flex-row items-center justify-center gap-1 rounded-lg border px-3 py-2.5"
          style={{ borderColor: colors.primary }}
        >
          <Radio size={14} color={colors.primary} />
          <Text className="text-sm" style={{ color: colors.primary }}>
            {t("connections:addRelay")}
          </Text>
        </Pressable>
      </View>

      <FlatList
        data={configs}
        keyExtractor={(c) => c.id}
        renderItem={({ item, index }) => (
          <ConnectionCard
            config={item}
            onEdit={() => openEdit(item)}
            isLast={index === configs.length - 1}
          />
        )}
        contentContainerStyle={{
          flexGrow: configs.length === 0 ? 1 : 0,
          margin: 16,
          overflow: "hidden",
          borderRadius: 16,
        }}
        ListEmptyComponent={
          <View className="flex-1 items-center justify-center px-4">
            <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
              {t("connections:empty")}
            </Text>
          </View>
        }
      />

      {/* 内容条件渲染：iOS Modal 程序化关闭不触发 onDismiss 时子树保持挂载
          （RN 0.88 _shouldShowModal = visible || isRendered），useState 不重初始化
          → 跨次打开残留上次表单（编辑 A 覆写 B / 重复条目）。卸载即根治。 */}
      <Modal
        visible={formVisible}
        animationType="slide"
        onRequestClose={closeForm}
      >
        {/* 全屏 Modal 无 Stack 头部，SafeAreaView 代 pt-10 手调（T13 布局顺手项） */}
        <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
          <View className="flex-1 bg-white px-4 dark:bg-black">
            {formVisible && (
              <ConnectionForm
                initial={editing}
                defaultMode={createMode}
                onDone={closeForm}
              />
            )}
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
