/**
 * token 上限输入字段：数字输入框 + 快捷预设 chips（输入/输出两列复用）
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface TokenLimitFieldProps {
  label: string;
  value: string;
  presets: number[];
  onChange: (value: string) => void;
  /** 联动校验失败时输入框红框 */
  error?: boolean;
  /** 底部提示（校验失败时红色显示） */
  hint?: string;
}

/** 1024 整数倍显示为 K（32768 → 32K），其余原样 */
function formatPresetLabel(value: number): string {
  return value >= 1024 && value % 1024 === 0
    ? `${value / 1024}K`
    : String(value);
}

export default function TokenLimitField({
  label,
  value,
  presets,
  onChange,
  error,
  hint,
}: TokenLimitFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        step="1"
        min="1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error || undefined}
        className={cn(
          error && "border-destructive focus-visible:ring-destructive",
        )}
      />
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(String(preset))}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
              Number(value) === preset
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border/50 text-muted-foreground hover:border-primary/30 hover:bg-primary-subtle hover:text-primary",
            )}
          >
            {formatPresetLabel(preset)}
          </button>
        ))}
      </div>
      {hint ? <p className="text-xs text-destructive">{hint}</p> : null}
    </div>
  );
}
