/**
 * 24 小时制时间输入框
 * 原生 <input type="time"> 的显示格式（12/24 小时）跟随系统 locale，
 * macOS 英文环境下会显示 AM/PM，且无法通过 --lang 开关或 HTML 属性覆盖。
 * 此组件用 text input 固定 "HH:mm" 24 小时显示，保证跨平台一致。
 */
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

interface TimeInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function TimeInput({
  value,
  onChange,
  disabled,
  className,
}: TimeInputProps) {
  const [text, setText] = useState(value);

  // 外部 value 变化时同步（如任务切换、时段重置、校验失败回退）
  useEffect(() => {
    setText(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // 仅保留数字与冒号，限制 5 字符
    const next = e.target.value.replace(/[^\d:]/g, "").slice(0, 5);
    setText(next);
    // 仅在完整且合法时通知父组件，避免中间态触发跨字段校验失败
    if (TIME_PATTERN.test(next)) {
      onChange(next);
    }
  };

  const handleBlur = () => {
    // 失焦时若不合法则回退到上次合法值
    if (!TIME_PATTERN.test(text)) {
      setText(value);
    }
  };

  return (
    <Input
      type="text"
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      disabled={disabled}
      placeholder="HH:mm"
      maxLength={5}
      inputMode="numeric"
      className={className}
    />
  );
}
