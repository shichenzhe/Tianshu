/**
 * 主布局组件
 * 包含顶部栏和主内容区（模块内布局由各模块自带，如 AI 标准侧边栏）
 */

import { useEffect } from "react";
import { useNavigate, useLocation, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useUserStore } from "@/domains/user/store/user.store";
import { UserApi } from "@/domains/user/api/user.api";
import AiTopbarActions from "@/domains/ai/layout/components/AiTopbarActions";
import TopBar from "./TopBar";

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation(["layout"]);
  const { user, isLoginValid, reset } = useUserStore();

  // 判断是否显示导航布局
  const shouldShowNav =
    location.pathname !== "/" && !location.pathname.includes("/login");

  // AI 模块在顶栏左侧注入折叠/搜索/筛选按钮
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
        <TopBar leftSlot={isAiRoute ? <AiTopbarActions /> : undefined} />
      )}

      <div
        className="main-content bg-muted/40"
        style={{
          marginTop: shouldShowNav ? 36 : 0,
          transition: "margin-top 0.2s",
        }}
      >
        <Outlet />
      </div>

      <style>{`
        .app-container {
          width: 100%;
          height: 100vh;
          overflow: hidden;
        }

        .main-content {
          height: calc(100vh - ${shouldShowNav ? 36 : 0}px);
          overflow-y: auto;
        }
      `}</style>
    </div>
  );
}
