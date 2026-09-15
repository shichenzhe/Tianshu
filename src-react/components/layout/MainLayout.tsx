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
import SessionSearchBox from "@/domains/ai/layout/components/SessionSearchBox";
import GlobalSidebar from "./GlobalSidebar";
import TopBar from "./TopBar";

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation(["layout"]);
  const { user, isLoginValid, reset } = useUserStore();

  // 判断是否显示导航布局
  const shouldShowNav =
    location.pathname !== "/" && !location.pathname.includes("/login");

  // 折叠/全局搜索/时间筛选三按钮作用于全局侧边栏（所有 /module 路由共用），
  // 项目等非 AI 路由同样注入；会话内搜索仍为 AI 会话专属
  const isAiRoute = location.pathname.startsWith("/module/ai");

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

  return (
    <div className="app-container">
      {shouldShowNav && (
        <TopBar
          leftSlot={<AiTopbarActions />}
          rightLeadingSlot={isAiRoute ? <SessionSearchBox /> : undefined}
        />
      )}

      <div
        className="main-content flex"
        style={{
          marginTop: shouldShowNav ? 36 : 0,
          transition: "margin-top 0.2s",
        }}
      >
        {shouldShowNav && <GlobalSidebar />}
        <main className="min-w-0 flex-1 overflow-y-auto bg-muted/40">
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
          height: calc(100vh - ${shouldShowNav ? 36 : 0}px);
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}
