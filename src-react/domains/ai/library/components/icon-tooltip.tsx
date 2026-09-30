/**
 * 纯图标按钮冒泡提示（资料库统一）：TooltipTrigger asChild 链到子按钮，
 * 可与 DropdownMenu/Popover 的 Trigger asChild 叠层（FilterPopover 先例）。
 * 子按钮自带 aria-label（无障碍语义保留）；原生 title 由调用方移除防双提示。
 */
import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface IconTooltipProps {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}

export default function IconTooltip({
  label,
  side = "bottom",
  children,
}: IconTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
