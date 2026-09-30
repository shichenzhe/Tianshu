/**
 * 主布局组件
 * 包含顶部栏和主内容区：内容区为横向 flex——全局侧边栏（GlobalSidebar，
 * 所有 /module/* 路由共用，主体区随模块切换）+ 主面板（Outlet 挂模块路由）
 */

import { useEffect } from "react";
import { useNavigate, useLocation, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useUserStore } from "@/domains/user/store/user.store";
import { UserApi } from "@/domains/user/api/user.api";
import AiTopbarActions from "@/domains/ai/layout/components/AiTopbarActions";
import GlobalSidebar from "./GlobalSidebar";
import TopBar from "./TopBar";
import { useSkinStore } from "@/stores/skin.store";
import { useClearWallpaper } from "@/lib/hooks";
import { cn } from "@/lib/utils";

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation(["layout"]);
  const { user, isLoginValid, reset } = useUserStore();
  // 皮肤 id：主面板底色依据——只有浅色基础款纯白，其余随主题色（见 main className）
  const skin = useSkinStore((s) => s.skin);

  // 判断是否显示导航布局
  const shouldShowNav =
    location.pathname !== "/" && !location.pathname.includes("/login");

  // 折叠/全局搜索/时间筛选三按钮作用于全局侧边栏（所有 /module 路由
  // 共用），项目等非 AI 路由同样注入；侧边栏收起时搜索/筛选随收起隐藏
  // （见 AiTopbarActions）；会话内搜索已随 ChatView 顶行迁入 TopBar
  // 中段（page-header），此处不再注入

  // 验证登录状态
  useEffect(() => {
    const checkAuth = async () => {
      if (location.pathname === "/login") return;

      if (!isLoginValid()) {
        toast.warning(t("auth.loginRequired"));
        navigate("/login");
        return;
      }

      try {
        const decoded = await UserApi.verifyToken(user.token);
        if (!decoded) {
          reset();
          toast.error(t("auth.loginExpired"));
          navigate("/login");
        }
      } catch {
        reset();
        toast.error(t("auth.loginVerifyFailed"));
        navigate("/login");
      }
    };

    checkAuth();
  }, [location.pathname, t]);

  // 主面板底色（TopBar 中段同款复用——顶部工具栏与面板融为一体）：
  // 仅浅色基础款纯白（与侧栏形成层次）；新建任务详情页（/module/ai/new）
  // 不叠底色（壁纸清晰模式，body 换极淡纱）；其余页面浓遮——body 壁纸
  // 轻纱层 + muted/80 合计保证文字/表格边框对比
  const isNewTaskRoute = useClearWallpaper();
  const panelClass =
    skin === "light" ? "bg-background" : isNewTaskRoute ? "" : "bg-muted/80";

  // 壁纸清晰模式标记：新建任务详情页在 html 打 data-clear-wallpaper，
  // skins.css 据此把 body 轻纱换成极淡版（离开该路由即摘除）
  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-clear-wallpaper",
      isNewTaskRoute,
    );
    return () =>
      document.documentElement.removeAttribute("data-clear-wallpaper");
  }, [isNewTaskRoute]);

  return (
    <div className="app-container">
      {shouldShowNav && (
        <TopBar leftSlot={<AiTopbarActions />} panelClass={panelClass} />
      )}

      <div
        className="main-content flex"
        style={{
          marginTop: shouldShowNav ? 44 : 0,
          transition: "margin-top 0.2s",
        }}
      >
        {shouldShowNav && <GlobalSidebar />}
        {/* 主面板：panelClass 与 TopBar 中段同源（见上方注释） */}
        <main className={cn("min-w-0 flex-1 overflow-y-auto", panelClass)}>
          <Outlet />
        </main>
      </div>

      <style>{`
        .app-container {
          width: 100%;
          height: 100vh;
          overflow: hidden;
        }

        .main-content {
          height: calc(100vh - ${shouldShowNav ? 44 : 0}px);
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}
