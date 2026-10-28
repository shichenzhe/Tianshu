import { Text, TextInput, View, type KeyboardTypeOptions } from "react-native";

/** 输入占位灰（跨组件同语义色） */
export const PLACEHOLDER = "#8E8E93";

/** 表单字段（A5 批自 providers 抽取共享）：label + 受控输入框 */
export function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  secure = false,
  multiline = false,
  editable = true,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
  editable?: boolean;
  keyboardType?: KeyboardTypeOptions;
}) {
  return (
    <View className="gap-1.5">
      <Text className="text-xs text-label2 dark:text-[#EBEBF599]">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={PLACEHOLDER}
        secureTextEntry={secure}
        multiline={multiline}
        editable={editable}
        keyboardType={keyboardType}
        autoCapitalize="none"
        autoCorrect={false}
        textAlignVertical={multiline ? "top" : "center"}
        className={`rounded-lg border border-sep bg-field px-3 py-2.5 text-sm text-black dark:border-[#545458A6] dark:bg-[#2C2C2E] dark:text-white ${
          multiline ? "min-h-24" : ""
        }`}
      />
    </View>
  );
}
