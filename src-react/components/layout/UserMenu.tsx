/**
 * 用户下拉菜单组件
 * 整合用户信息、修改密码、帮助、退出登录等功能
 */

import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  User,
  Lock,
  LogOut,
  Settings,
  Lightbulb,
  HelpCircle,
  RefreshCw,
  FileText,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { useUserStore } from "@/domains/user/store/user.store";
import { useSettingsUiStore } from "@/domains/app-settings/store/settings-ui.store";
import UserInfoDialog from "@/domains/user/components/UserInfoDialog";
import PasswordDialog from "@/domains/user/components/PasswordDialog";
import UpdateLogDialog from "@/components/common/UpdateLogDialog";
import SettingsDialog from "@/domains/app-settings/components/SettingsDialog";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useClearWallpaper } from "@/lib/hooks";

export default function UserMenu() {
  const { t } = useTranslation(["layout", "common"]);
  // 清晰壁纸路由（新建任务详情页）触发按钮切实底，与主题色区分
  const solid = useClearWallpaper();
  const navigate = useNavigate();
  const { user, reset } = useUserStore();

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [userInfoDialogOpen, setUserInfoDialogOpen] = useState(false);
  const [updateLogDialogOpen, setUpdateLogDialogOpen] = useState(false);
  // 设置面板 open 态走 Zustand：用户菜单与 ⌘, 快捷键共用（见 GlobalSidebar 分发器）
  const settingsOpen = useSettingsUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useSettingsUiStore((s) => s.setSettingsOpen);
  const openSettings = useSettingsUiStore((s) => s.openSettings);
  const [logoutDialogOpen, setLogoutDialogOpen] = useState(false);
  const [checkUpdateDialogOpen, setCheckUpdateDialogOpen] = useState(false);
  const [updateAvailableDialogOpen, setUpdateAvailableDialogOpen] =
    useState(false);
  const [updateDownloadedDialogOpen, setUpdateDownloadedDialogOpen] =
    useState(false);

  // 下拉菜单 hover 状态
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTimer = useRef<NodeJS.Timeout | null>(null);

  // 退出登录
  const handleLogout = () => {
    reset();
    navigate("/login");
    toast.success(t("layout:userMenu.logoutSuccess"));
  };

  // 检查更新
  const handleCheckUpdate = () => {
    if (!window.ipcRenderer) {
      toast.warning(t("layout:userMenu.updateOnlyDesktop"));
      return;
    }
    setCheckUpdateDialogOpen(true);
  };

  // 确认检查更新
  const handleConfirmCheckUpdate = () => {
    window.ipcRenderer.send("check-for-updates");
    toast.info(t("layout:userMenu.checkingUpdate"));
  };

  // 确认安装更新
  const handleConfirmInstallUpdate = () => {
    window.ipcRenderer.send("install-update");
  };

  // 取消安装更新
  const handleCancelInstallUpdate = () => {
    toast.info(t("layout:userMenu.installLaterHint"));
  };

  // 设置更新监听器
  useEffect(() => {
    if (!window.ipcRenderer) return;

    const handleUpdateAvailable = () => {
      setUpdateAvailableDialogOpen(true);
    };

    const handleUpdateDownloaded = () => {
      setUpdateDownloadedDialogOpen(true);
    };

    const handleUpdateNotAvailable = () => {
      toast.success(t("layout:userMenu.alreadyLatest"));
    };

    const handleUpdateError = (_event: unknown, error: unknown) => {
      toast.error(t("layout:userMenu.updateCheckFailed", { error }));
    };

    window.ipcRenderer.on("update-available", handleUpdateAvailable);
    window.ipcRenderer.on("update-downloaded", handleUpdateDownloaded);
    window.ipcRenderer.on("update-not-available", handleUpdateNotAvailable);
    window.ipcRenderer.on("update-error", handleUpdateError);

    return () => {
      window.ipcRenderer.removeAllListeners("update-available");
      window.ipcRenderer.removeAllListeners("update-downloaded");
      window.ipcRenderer.removeAllListeners("update-not-available");
      window.ipcRenderer.removeAllListeners("update-error");
    };
  }, []);

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open) {
            menuTimer.current = setTimeout(() => setMenuOpen(false), 200);
          }
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <div
            className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer ${
              solid
                ? "bg-card border border-border/50 hover:bg-muted"
                : "hover:bg-accent"
            } text-foreground transition-all duration-200`}
            onMouseEnter={() => {
              if (menuTimer.current) clearTimeout(menuTimer.current);
              setMenuOpen(true);
            }}
            onMouseLeave={() => {
              menuTimer.current = setTimeout(() => setMenuOpen(false), 200);
            }}
          >
            <User size={16} />
            <span className="text-sm max-w-[80px] truncate">
              {user?.username || t("layout:userMenu.defaultUser")}
            </span>
            <ChevronDown size={14} className="text-muted-foreground" />
          </div>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44"
          sideOffset={2}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onMouseEnter={() => {
            if (menuTimer.current) clearTimeout(menuTimer.current);
          }}
          onMouseLeave={() => {
            menuTimer.current = setTimeout(() => setMenuOpen(false), 200);
          }}
        >
          <DropdownMenuItem
            onClick={() => setUserInfoDialogOpen(true)}
            className="cursor-pointer"
          >
            <User size={14} className="mr-2" />
            {t("layout:userMenu.userInfo")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setPasswordDialogOpen(true)}
            className="cursor-pointer"
          >
            <Lock size={14} className="mr-2" />
            {t("layout:userMenu.changePassword")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setSettingsOpen(true)}
            className="cursor-pointer"
          >
            <Settings size={14} className="mr-2" />
            {t("layout:userMenu.settings")}
          </DropdownMenuItem>
          {/* 记忆与进化：直达设置面板记忆页 */}
          <DropdownMenuItem
            onClick={() => openSettings("memory")}
            className="cursor-pointer"
          >
            <Lightbulb size={14} className="mr-2" />
            {t("layout:userMenu.memoryEvolution")}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="cursor-pointer">
              <HelpCircle size={14} className="mr-2" />
              {t("layout:userMenu.help")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onClick={handleCheckUpdate}
                className="cursor-pointer"
              >
                <RefreshCw size={14} className="mr-2" />
                {t("layout:userMenu.checkUpdate")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setUpdateLogDialogOpen(true)}
                className="cursor-pointer"
              >
                <FileText size={14} className="mr-2" />
                {t("layout:userMenu.updateLog")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setLogoutDialogOpen(true)}
            className="cursor-pointer text-destructive focus:text-destructive"
          >
            <LogOut size={14} className="mr-2" />
            {t("layout:userMenu.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 对话框 */}
      <UserInfoDialog
        open={userInfoDialogOpen}
        onOpenChange={setUserInfoDialogOpen}
      />
      <PasswordDialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
      />
      <UpdateLogDialog
        open={updateLogDialogOpen}
        onOpenChange={setUpdateLogDialogOpen}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* 退出登录确认 */}
      <AlertDialog open={logoutDialogOpen} onOpenChange={setLogoutDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("layout:userMenu.logoutConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("layout:userMenu.logoutConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleLogout}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 检查更新确认 */}
      <AlertDialog
        open={checkUpdateDialogOpen}
        onOpenChange={setCheckUpdateDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("layout:userMenu.checkUpdateTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("layout:userMenu.checkUpdateDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmCheckUpdate}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 发现新版本确认 */}
      <AlertDialog
        open={updateAvailableDialogOpen}
        onOpenChange={setUpdateAvailableDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("layout:userMenu.updateAvailableTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("layout:userMenu.updateAvailableDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("layout:userMenu.remindLater")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => toast.info(t("layout:userMenu.downloading"))}
            >
              {t("layout:userMenu.downloadNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 更新下载完成确认 */}
      <AlertDialog
        open={updateDownloadedDialogOpen}
        onOpenChange={setUpdateDownloadedDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("layout:userMenu.installUpdateTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("layout:userMenu.installUpdateDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelInstallUpdate}>
              {t("layout:userMenu.installLater")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmInstallUpdate}>
              {t("layout:userMenu.installNow")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
