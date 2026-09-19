/**
 * 登录页面
 * 支持用户登录和注册功能
 */

import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { User, Lock, Mail } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { useUserStore } from "../store/user.store";
import { UserApi, UserLoginParams, UserCreateParams } from "../api/user.api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import AppLogo from "@/components/common/AppLogo";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LoginForm {
  username: string;
  password: string;
  rememberMe: boolean;
}

interface RegisterForm {
  username: string;
  nickname: string;
  email: string;
  password: string;
}

export default function LoginView() {
  const { t } = useTranslation(["user", "common"]);
  const navigate = useNavigate();
  const { setUserInfo, setExpiration, isLoginValid } = useUserStore();

  // 登录表单
  const [loginForm, setLoginForm] = useState<LoginForm>({
    username: localStorage.getItem("lastUsername") || "",
    password: "",
    rememberMe: localStorage.getItem("rememberMe") === "true",
  });

  // 注册表单
  const [registerForm, setRegisterForm] = useState<RegisterForm>({
    username: "",
    nickname: "",
    email: "",
    password: "",
  });

  // 状态
  const [isLoading, setIsLoading] = useState(false);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [registerDialogOpen, setRegisterDialogOpen] = useState(false);

  // 表单验证错误
  const [loginErrors, setLoginErrors] = useState<{
    username?: string;
    password?: string;
  }>({});

  const [registerErrors, setRegisterErrors] = useState<{
    username?: string;
    email?: string;
    password?: string;
  }>({});

  // 输入框引用
  const usernameInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  // 初始化：检查是否已登录
  useEffect(() => {
    if (isLoginValid()) {
      // 已登录直达：默认落地新建任务页（与应用入口一致）
      navigate("/module/ai/new", { replace: true });
      return;
    }

    // 自动聚焦
    const timer = setTimeout(() => {
      if (!loginForm.username) {
        usernameInputRef.current?.focus();
      } else {
        passwordInputRef.current?.focus();
      }
    }, 100);

    return () => clearTimeout(timer);
  }, []);

  // 监听记住我选项
  useEffect(() => {
    localStorage.setItem("rememberMe", loginForm.rememberMe.toString());
  }, [loginForm.rememberMe]);

  // 监听用户名变化
  useEffect(() => {
    if (loginForm.username) {
      localStorage.setItem("lastUsername", loginForm.username);
    }
  }, [loginForm.username]);

  // 验证登录表单
  const validateLoginForm = (): boolean => {
    const errors: typeof loginErrors = {};

    if (!loginForm.username) {
      errors.username = t("user:login.usernameRequired");
    }
    if (!loginForm.password) {
      errors.password = t("user:login.passwordRequired");
    }

    setLoginErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // 验证注册表单
  const validateRegisterForm = (): boolean => {
    const errors: typeof registerErrors = {};

    if (!registerForm.username) {
      errors.username = t("user:register.usernameRequired");
    }
    if (!registerForm.email) {
      errors.email = t("user:register.emailRequired");
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registerForm.email)) {
      errors.email = t("user:register.emailInvalid");
    }
    if (!registerForm.password) {
      errors.password = t("user:register.passwordRequired");
    }

    setRegisterErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // 处理登录
  const handleLogin = async () => {
    if (!validateLoginForm()) return;

    setIsLoading(true);
    try {
      const params: UserLoginParams = {
        username: loginForm.username,
        password: loginForm.password,
      };

      const userAuth = await UserApi.login(params);

      if (!userAuth) {
        toast.error(t("user:login.invalidCredentials"));
        setIsLoading(false);
        return;
      }

      // 保存用户信息
      setUserInfo(userAuth);

      // 设置过期时间
      if (loginForm.rememberMe) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        setExpiration(expiresAt.getTime());
      } else {
        setExpiration(null);
      }

      toast.success(t("user:login.loginSuccess"));
      // 登录成功默认落地新建任务页（与应用入口一致）
      navigate("/module/ai/new");
    } catch (error) {
      console.error("登录失败:", error);
      toast.error(t("user:login.loginFailed"));
    } finally {
      setIsLoading(false);
    }
  };

  // 处理注册
  const handleRegister = async () => {
    if (!validateRegisterForm()) return;

    setRegisterLoading(true);
    try {
      const params: UserCreateParams = {
        username: registerForm.username,
        nickname: registerForm.nickname || undefined,
        email: registerForm.email,
        password: registerForm.password,
      };

      const result = await UserApi.create(params);

      if (result === -1) {
        toast.error(t("user:register.duplicateUser"));
        setRegisterLoading(false);
        return;
      }

      toast.success(t("user:register.registerSuccess"));
      setRegisterDialogOpen(false);

      // 自动填充登录表单
      setLoginForm((prev) => ({
        ...prev,
        username: registerForm.username,
        password: registerForm.password,
      }));

      // 重置注册表单
      setRegisterForm({
        username: "",
        nickname: "",
        email: "",
        password: "",
      });
      setRegisterErrors({});
    } catch (error) {
      console.error("注册失败:", error);
      toast.error(t("user:register.registerFailed"));
    } finally {
      setRegisterLoading(false);
    }
  };

  // 处理回车键登录
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleLogin();
    }
  };

  return (
    <div className="flex justify-center items-center h-screen bg-gradient-to-br from-primary-subtle via-background to-primary-subtle relative">
      {/* Logo 区域 */}
      <div className="absolute top-6 left-6 flex items-center gap-3">
        <AppLogo className="w-8 h-8" />
        <span className="text-xl font-bold text-primary tracking-tight select-none">
          {t("common:appName")}
        </span>
        <span className="text-xs text-muted-foreground select-none">
          {__APP_VERSION__}
        </span>
      </div>

      {/* 登录卡片 */}
      <Card className="w-96 bg-card rounded-lg shadow-sm border border-border/50 p-6">
        <h2 className="text-center text-primary text-2xl mb-6 font-semibold">
          {t("user:login.title")}
        </h2>

        <div className="space-y-4">
          {/* 用户名 */}
          <div className="space-y-2">
            <Label htmlFor="username">{t("user:login.username")}</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                id="username"
                ref={usernameInputRef}
                placeholder={t("user:login.usernamePlaceholder")}
                value={loginForm.username}
                onChange={(e) =>
                  setLoginForm((prev) => ({
                    ...prev,
                    username: e.target.value,
                  }))
                }
                onKeyDown={handleKeyDown}
                className="pl-9"
              />
            </div>
            {loginErrors.username && (
              <p className="text-sm text-destructive">{loginErrors.username}</p>
            )}
          </div>

          {/* 密码 */}
          <div className="space-y-2">
            <Label htmlFor="password">{t("user:login.password")}</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                id="password"
                ref={passwordInputRef}
                type="password"
                placeholder={t("user:login.passwordPlaceholder")}
                value={loginForm.password}
                onChange={(e) =>
                  setLoginForm((prev) => ({
                    ...prev,
                    password: e.target.value,
                  }))
                }
                onKeyDown={handleKeyDown}
                className="pl-9"
              />
            </div>
            {loginErrors.password && (
              <p className="text-sm text-destructive">{loginErrors.password}</p>
            )}
          </div>

          {/* 记住我 */}
          <div className="flex items-center space-x-2">
            <Checkbox
              id="remember"
              checked={loginForm.rememberMe}
              onCheckedChange={(checked) =>
                setLoginForm((prev) => ({
                  ...prev,
                  rememberMe: checked as boolean,
                }))
              }
            />
            <Label
              htmlFor="remember"
              className="text-sm text-primary cursor-pointer"
            >
              {t("user:login.rememberMe")}
            </Label>
          </div>

          {/* 登录按钮 */}
          <Button
            onClick={handleLogin}
            disabled={isLoading}
            className="w-full rounded-md mt-4 h-10"
          >
            {isLoading ? t("user:login.loggingIn") : t("user:login.submit")}
          </Button>

          {/* 注册按钮 */}
          <div className="text-center mt-4">
            <Button
              type="button"
              variant="link"
              onClick={() => setRegisterDialogOpen(true)}
              className="text-primary hover:underline h-auto p-0"
            >
              {t("user:login.noAccount")}
            </Button>
          </div>
        </div>
      </Card>

      {/* 注册对话框 */}
      <Dialog open={registerDialogOpen} onOpenChange={setRegisterDialogOpen}>
        <DialogContent className="sm:max-w-[400px] rounded-lg">
          <DialogHeader>
            <DialogTitle>{t("user:register.title")}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* 用户名 */}
            <div className="space-y-2">
              <Label htmlFor="reg-username">
                {t("user:register.username")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  id="reg-username"
                  placeholder={t("user:register.usernamePlaceholder")}
                  value={registerForm.username}
                  onChange={(e) =>
                    setRegisterForm((prev) => ({
                      ...prev,
                      username: e.target.value,
                    }))
                  }
                  className="pl-9"
                />
              </div>
              {registerErrors.username && (
                <p className="text-sm text-destructive">
                  {registerErrors.username}
                </p>
              )}
            </div>

            {/* 昵称 */}
            <div className="space-y-2">
              <Label htmlFor="reg-nickname">
                {t("user:register.nickname")}
              </Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  id="reg-nickname"
                  placeholder={t("user:register.nicknamePlaceholder")}
                  value={registerForm.nickname}
                  onChange={(e) =>
                    setRegisterForm((prev) => ({
                      ...prev,
                      nickname: e.target.value,
                    }))
                  }
                  className="pl-9"
                />
              </div>
            </div>

            {/* 邮箱 */}
            <div className="space-y-2">
              <Label htmlFor="reg-email">
                {t("user:register.email")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  id="reg-email"
                  type="email"
                  placeholder={t("user:register.emailPlaceholder")}
                  value={registerForm.email}
                  onChange={(e) =>
                    setRegisterForm((prev) => ({
                      ...prev,
                      email: e.target.value,
                    }))
                  }
                  className="pl-9"
                />
              </div>
              {registerErrors.email && (
                <p className="text-sm text-destructive">
                  {registerErrors.email}
                </p>
              )}
            </div>

            {/* 密码 */}
            <div className="space-y-2">
              <Label htmlFor="reg-password">
                {t("user:register.password")}{" "}
                <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <Input
                  id="reg-password"
                  type="password"
                  placeholder={t("user:register.passwordPlaceholder")}
                  value={registerForm.password}
                  onChange={(e) =>
                    setRegisterForm((prev) => ({
                      ...prev,
                      password: e.target.value,
                    }))
                  }
                  className="pl-9"
                />
              </div>
              {registerErrors.password && (
                <p className="text-sm text-destructive">
                  {registerErrors.password}
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRegisterDialogOpen(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleRegister}
              disabled={registerLoading}
            >
              {registerLoading
                ? t("user:register.registering")
                : t("user:register.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
