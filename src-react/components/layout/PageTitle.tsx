/**
 * 页面标题组件
 * 带有渐变背景的标题栏
 */

interface PageTitleProps {
  title: string;
  gradient?: boolean;
  /** 标题左侧内容（如标题行左侧的操作按钮）；可选，不影响既有用法 */
  leading?: React.ReactNode;
  children?: React.ReactNode;
}

export default function PageTitle({
  title,
  gradient = true,
  leading,
  children,
}: PageTitleProps) {
  return (
    <div className="mb-2 rounded-lg overflow-hidden shadow-sm border border-primary/20">
      <div
        className={`px-4 py-2 text-primary-foreground flex items-center justify-between ${
          gradient
            ? "bg-gradient-to-r from-primary to-primary-active"
            : "bg-primary"
        }`}
      >
        <div className="flex items-center gap-2">
          {leading}
          <h2 className="text-base font-medium">{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}
