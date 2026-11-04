import * as React from "react";
import { Toaster as SonnerToaster, toast, type ToastT } from "sonner";

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <SonnerToaster
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

/**
 * 点击任意处关闭单条的 Toaster——sonner 2.x 仅支持 swipe/关闭按钮，无内建
 * 点击关闭；经事件委托实现：li[data-sonner-toast] 的 data-index 对位
 * toast.getHistory().reverse()——store 数组新在尾、渲染数组新插头，两者
 * 恒为倒序（新增/移除/动画期标记三操作两侧同步，含 dismiss 动画期条目；
 * getToasts() 会立即剔除被标记条目反而错位）。li 文本兜底校验防极端
 * 错位窗口——宁可不关，不错关。按钮区域（关闭/动作/取消）除外，走原生
 */
const DismissableToaster = ({ toastOptions, ...props }: ToasterProps) => {
  const handleDismissOnClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;
    const li = target.closest("li[data-sonner-toast]");
    if (!(li instanceof HTMLElement) || li.dataset.removed === "true") return;
    // getHistory 元素运行时恒为完整 ToastT（union 类型是保守声明），dismiss
    // 标记条目 id 仍可安全重关
    const clicked = [...toast.getHistory()].reverse()[
      Number(li.dataset.index)
    ] as ToastT | undefined;
    if (
      clicked &&
      typeof clicked.title === "string" &&
      li.textContent?.includes(clicked.title)
    ) {
      toast.dismiss(clicked.id);
    }
  };

  return (
    // contents 不生成盒子，不影响 Toaster 自身 fixed 定位与布局
    <div className="contents" onClick={handleDismissOnClick}>
      <SonnerToaster
        toastOptions={{
          ...toastOptions,
          classNames: {
            toast: "cursor-pointer",
            ...toastOptions?.classNames,
          },
        }}
        {...props}
      />
    </div>
  );
};

export { Toaster, DismissableToaster, toast as sonnerToast };
