/**
 * 页面标题组件
 * 带有渐变背景的标题栏
 */

interface PageTitleProps {
  title: string;
  gradient?: boolean;
  children?: React.ReactNode;
}

export default function PageTitle({
  title,
  gradient = true,
  children,
}: PageTitleProps) {
  return (
    <div className="mb-2 rounded-lg overflow-hidden shadow-sm border border-primary/20">
      <div
        className={`px-4 py-2 text-white flex items-center justify-between ${
          gradient
            ? "bg-gradient-to-r from-primary to-primary-active"
            : "bg-primary"
        }`}
      >
        <h2 className="text-base font-medium">{title}</h2>
        {children}
      </div>
    </div>
  );
}
