/** 数据安全卡片占位（Task 9 提供完整实现，签名保持一致） */
import type { SecurityConfig, SecurityConfigKey } from "../model/types";

export default function DataSafetyCard(props: {
  config: SecurityConfig;
  onUpdate: (key: SecurityConfigKey, value: unknown) => void;
}) {
  void props;
  return null;
}
