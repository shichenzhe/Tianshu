// CSV 只读表格预览弹层（A5 尾富媒体批）：library/read 拉文本 → 纯客户端
// 解析（csv-table splitter）→ 横纵双向滚动表格。渲染上限 200 行 × 20 列，
// 超限行/列截断 + 表尾提示行（i18n）；单元格单行省略号（引号内换行渲前
// 归空格）；只读，不做编辑/写回。RN 铁律：行内不用 flex-1（Yoga 0 高），
// 列宽走 minWidth + 内容撑开。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { X } from "lucide-react-native";

import { buildCsvTable, type CsvTable } from "@/logic/csv-table";
import { useLibraryStore, type LibraryRow } from "@/store/library.store";

type CsvState =
  | { status: "loading" }
  | { status: "ok"; table: CsvTable }
  | { status: "failed" };

/** 单元格单行化：引号内换行归空格（单行省略号语义） */
function cellText(value: string): string {
  return value.replace(/\s*\n\s*/g, " ");
}

/** 表格行：等宽列格（minWidth 96），单行省略号 */
function CsvRow({ row, isFirst }: { row: string[]; isFirst: boolean }) {
  return (
    <View className="flex-row border-b border-sep dark:border-[#545458A6]">
      {row.map((cell, index) => (
        <Text
          key={index}
          numberOfLines={1}
          className={`min-w-24 border-r border-sep px-2 py-1.5 text-xs text-black dark:border-[#545458A6] dark:text-white ${
            isFirst ? "font-medium" : ""
          }`}
        >
          {cellText(cell)}
        </Text>
      ))}
    </View>
  );
}

/**
 * CSV 只读表格弹层：visible 置 true 时经 readText 拉取并解析；失败占位
 * 文案（previewFailed）；空表 csvEmpty；截断时表尾提示行（行/列各一条）。
 */
export function CsvPreviewModal({
  item,
  visible,
  onClose,
}: {
  item: LibraryRow | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("library");
  const readText = useLibraryStore((state) => state.readText);
  const [state, setState] = useState<CsvState>({ status: "loading" });

  useEffect(() => {
    if (!visible || !item) return;
    let cancelled = false;
    setState({ status: "loading" });
    readText(item.id)
      .then((content) => {
        if (!cancelled)
          setState({ status: "ok", table: buildCsvTable(content) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, item, readText]);

  const table = state.status === "ok" ? state.table : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-black/80">
        <Pressable
          accessibilityLabel={t("back")}
          hitSlop={12}
          className="absolute right-5 top-14 z-10"
          onPress={onClose}
        >
          <X size={24} color="white" />
        </Pressable>
        <View className="flex-1 items-center justify-center px-4">
          <View className="max-h-[80%] w-full rounded-2xl bg-white p-3 dark:bg-[#1C1C1E]">
            {item && (
              <Text
                numberOfLines={1}
                className="mb-2 text-sm font-medium text-black dark:text-white"
              >
                {item.name}
              </Text>
            )}
            {state.status === "loading" ? (
              <View className="h-40 items-center justify-center">
                <ActivityIndicator color="#8E8E93" size="small" />
              </View>
            ) : state.status === "failed" ? (
              <View className="h-40 items-center justify-center">
                <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
                  {t("previewFailed")}
                </Text>
              </View>
            ) : table && table.rows.length === 0 ? (
              <View className="h-40 items-center justify-center">
                <Text className="text-center text-sm text-label2 dark:text-[#EBEBF599]">
                  {t("csvEmpty")}
                </Text>
              </View>
            ) : table ? (
              <>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator
                  style={{ flexGrow: 0, flexShrink: 1 }}
                >
                  <ScrollView
                    showsVerticalScrollIndicator
                    style={{ flexGrow: 0, flexShrink: 1 }}
                  >
                    <View>
                      {table.rows.map((row, index) => (
                        <CsvRow key={index} row={row} isFirst={index === 0} />
                      ))}
                    </View>
                  </ScrollView>
                </ScrollView>
                {(table.truncatedRows || table.truncatedCols) && (
                  <View className="mt-2 gap-0.5">
                    {table.truncatedRows && (
                      <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                        {t("csvTruncatedRows", {
                          shown: table.rows.length,
                          total: table.totalRows,
                        })}
                      </Text>
                    )}
                    {table.truncatedCols && (
                      <Text className="text-xs text-label3 dark:text-[#EBEBF54D]">
                        {t("csvTruncatedCols", {
                          shown: table.rows[0]?.length ?? 0,
                          total: table.totalCols,
                        })}
                      </Text>
                    )}
                  </View>
                )}
              </>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
