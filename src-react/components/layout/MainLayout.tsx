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
import { useClearWallpaper } from "@/lib/hooks";

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation(["layout"]);
  const { user, isLoginValid, reset } = useUserStore();

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

  // 壁纸模式标记（html 属性由 skins.css 消费）：新建任务详情页打
  // data-clear-wallpaper（body 轻纱换极淡版，壁纸近乎全清晰）；其余路由
  // 打 data-no-wallpaper（body 壁纸图关闭，换 --skin-panel-bg 纯色底）
  // ——壁纸仅新建任务主面板与登录页显示（参照 WorkBuddy，其余模块纯色
  // 保可读）；两者互斥，离开路由/卸载即摘除。主面板/顶栏中段不叠底色，
  // 统一透 body（新建任务页同先例）
  const isNewTaskRoute = useClearWallpaper();

  useEffect(() => {
    document.documentElement.toggleAttribute(
      "data-clear-wallpaper",
      isNewTaskRoute,
    );
    document.documentElement.toggleAttribute(
      "data-no-wallpaper",
      !isNewTaskRoute,
    );
    return () => {
      document.documentElement.removeAttribute("data-clear-wallpaper");
      document.documentElement.removeAttribute("data-no-wallpaper");
    };
  }, [isNewTaskRoute]);

  return (
    <div className="app-container">
      {shouldShowNav && <TopBar leftSlot={<AiTopbarActions />} />}

      <div
        className="main-content flex"
        style={{
          marginTop: shouldShowNav ? 44 : 0,
          transition: "margin-top 0.2s",
        }}
      >
        {shouldShowNav && <GlobalSidebar />}
        {/* 主面板：不叠底色，统一透 body（壁纸清晰/纯色由 html 属性+skins.css 决定）；
            Outlet 按路由 key 重挂载 + page-enter 进场动画（淡入微上浮），消除
            模块切换内容硬切——包装须带 h-full，否则内部视图的 h-full 高度链断裂 */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div key={location.pathname} className="page-enter h-full">
            <Outlet />
          </div>
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
