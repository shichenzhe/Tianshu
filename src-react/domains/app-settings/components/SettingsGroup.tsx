/**
 * 设置分组容器
 * 右栏滚动区内的一个分组：分组标题 + 可选内容区（内容为空时仅渲染标题，
 * 由后续任务填充具体控件）
 */

import type { ReactNode } from "react";

interface SettingsGroupProps {
  title: string;
  children?: ReactNode;
}

export default function SettingsGroup({ title, children }: SettingsGroupProps) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children && (
        <div className="space-y-5 rounded-lg border border-border/50 bg-card p-4">
          {children}
        </div>
      )}
    </section>
  );
}
