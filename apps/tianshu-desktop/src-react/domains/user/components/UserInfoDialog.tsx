/**
 * 修改用户信息对话框
 */

import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { useUserStore } from "../store/user.store";
import { UserApi } from "../api/user.api";

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface UserInfoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FormData {
  id: number;
  username: string;
  nickname: string;
  email: string;
}

export default function UserInfoDialog({
  open,
  onOpenChange,
}: UserInfoDialogProps) {
  const { t } = useTranslation(["user", "common"]);
  const { user, setUserInfo } = useUserStore();
  const usernameInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState<FormData>({
    id: 0,
    username: "",
    nickname: "",
    email: "",
  });

  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>(
    {},
  );
  const [loading, setLoading] = useState(false);

  // 初始化表单数据
  const initFormData = async () => {
    try {
      const userInfo = await UserApi.getByUsername(user.username);
      setFormData({
        id: userInfo.id,
        username: userInfo.username,
        nickname: userInfo.nickname || "",
        email: userInfo.email || "",
      });
    } catch (error) {
      console.error("获取用户信息失败:", error);
      toast.error(t("user:userInfo.loadFailed"));
    }
  };

  // 对话框打开时初始化
  useEffect(() => {
    if (open) {
      initFormData();
      setTimeout(() => {
        usernameInputRef.current?.focus();
      }, 100);
    }
  }, [open]);

  // 验证表单
  const validateForm = (): boolean => {
    const newErrors: Partial<Record<keyof FormData, string>> = {};

    if (!formData.username.trim()) {
      newErrors.username = t("user:userInfo.usernameRequired");
    }
    if (!formData.nickname.trim()) {
      newErrors.nickname = t("user:userInfo.nicknameRequired");
    }
    if (!formData.email.trim()) {
      newErrors.email = t("user:userInfo.emailRequired");
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = t("user:userInfo.emailInvalid");
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // 提交表单
  const handleSubmit = async () => {
    if (!validateForm()) return;

    setLoading(true);
    try {
      const params = {
        id: formData.id,
        username: formData.username,
        nickname: formData.nickname,
        email: formData.email,
      };

      const result = await UserApi.modify(params);

      if (result === -1) {
        toast.error(t("user:userInfo.duplicateUser"));
        setLoading(false);
        return;
      }

      setUserInfo({
        id: formData.id,
        username: formData.username,
        nickname: formData.nickname,
        email: formData.email,
      });

      toast.success(t("user:userInfo.updateSuccess"));
      onOpenChange(false);
    } catch (error) {
      console.error("修改用户信息失败:", error);
      toast.error(t("user:userInfo.updateFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 关闭对话框
  const handleClose = () => {
    onOpenChange(false);
    setErrors({});
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t("user:userInfo.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* 用户名 */}
          <div className="space-y-2">
            <Label htmlFor="username">
              {t("user:userInfo.username")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="username"
              ref={usernameInputRef}
              value={formData.username}
              onChange={(e) =>
                setFormData({ ...formData, username: e.target.value })
              }
              placeholder={t("user:userInfo.usernamePlaceholder")}
            />
            {errors.username && (
              <p className="text-sm text-destructive">{errors.username}</p>
            )}
          </div>

          {/* 昵称 */}
          <div className="space-y-2">
            <Label htmlFor="nickname">
              {t("user:userInfo.nickname")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="nickname"
              value={formData.nickname}
              onChange={(e) =>
                setFormData({ ...formData, nickname: e.target.value })
              }
              placeholder={t("user:userInfo.nicknamePlaceholder")}
            />
            {errors.nickname && (
              <p className="text-sm text-destructive">{errors.nickname}</p>
            )}
          </div>

          {/* 邮箱 */}
          <div className="space-y-2">
            <Label htmlFor="email">
              {t("user:userInfo.email")}{" "}
              <span className="text-destructive">*</span>
            </Label>
            <Input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) =>
                setFormData({ ...formData, email: e.target.value })
              }
              placeholder={t("user:userInfo.emailPlaceholder")}
            />
            {errors.email && (
              <p className="text-sm text-destructive">{errors.email}</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            {t("common:cancel")}
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={loading}>
            {loading
              ? t("common:submitting")
              : t("user:userInfo.confirmUpdate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
