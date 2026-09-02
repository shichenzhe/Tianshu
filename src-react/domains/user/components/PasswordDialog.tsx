/**
 * 修改密码对话框
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

interface PasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FormData {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export default function PasswordDialog({
  open,
  onOpenChange,
}: PasswordDialogProps) {
  const { t } = useTranslation(["user", "common"]);
  const { user } = useUserStore();
  const currentPasswordInputRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState<FormData>({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });

  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>(
    {},
  );
  const [loading, setLoading] = useState(false);

  // 对话框打开时重置表单并聚焦
  useEffect(() => {
    if (open) {
      setFormData({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      setErrors({});
      setTimeout(() => {
        currentPasswordInputRef.current?.focus();
      }, 100);
    }
  }, [open]);

  // 验证表单
  const validateForm = (): boolean => {
    const newErrors: Partial<Record<keyof FormData, string>> = {};

    if (!formData.currentPassword) {
      newErrors.currentPassword = t("user:password.currentPasswordRequired");
    }
    if (!formData.newPassword) {
      newErrors.newPassword = t("user:password.newPasswordRequired");
    }
    if (!formData.confirmPassword) {
      newErrors.confirmPassword = t("user:password.confirmPasswordRequired");
    } else if (formData.newPassword !== formData.confirmPassword) {
      newErrors.confirmPassword = t("user:password.passwordMismatch");
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
        username: user.username,
        oldPassword: formData.currentPassword,
        newPassword: formData.newPassword,
      };

      const isValid = await UserApi.modifyPassword(params);

      if (!isValid) {
        toast.error(t("user:password.wrongPassword"));
        setLoading(false);
        return;
      }

      toast.success(t("user:password.updateSuccess"));
      onOpenChange(false);
    } catch (error) {
      console.error("修改密码失败:", error);
      toast.error(t("user:password.updateFailed"));
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
          <DialogTitle>{t("user:password.title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* 当前密码 */}
          <div className="space-y-2">
            <Label htmlFor="current-password">
              {t("user:password.currentPassword")}{" "}
              <span className="text-red-500">*</span>
            </Label>
            <Input
              id="current-password"
              ref={currentPasswordInputRef}
              type="password"
              value={formData.currentPassword}
              onChange={(e) =>
                setFormData({ ...formData, currentPassword: e.target.value })
              }
              placeholder={t("user:password.currentPasswordPlaceholder")}
            />
            {errors.currentPassword && (
              <p className="text-sm text-red-500">{errors.currentPassword}</p>
            )}
          </div>

          {/* 新密码 */}
          <div className="space-y-2">
            <Label htmlFor="new-password">
              {t("user:password.newPassword")}{" "}
              <span className="text-red-500">*</span>
            </Label>
            <Input
              id="new-password"
              type="password"
              value={formData.newPassword}
              onChange={(e) =>
                setFormData({ ...formData, newPassword: e.target.value })
              }
              placeholder={t("user:password.newPasswordPlaceholder")}
            />
            {errors.newPassword && (
              <p className="text-sm text-red-500">{errors.newPassword}</p>
            )}
          </div>

          {/* 确认新密码 */}
          <div className="space-y-2">
            <Label htmlFor="confirm-password">
              {t("user:password.confirmPassword")}{" "}
              <span className="text-red-500">*</span>
            </Label>
            <Input
              id="confirm-password"
              type="password"
              value={formData.confirmPassword}
              onChange={(e) =>
                setFormData({ ...formData, confirmPassword: e.target.value })
              }
              placeholder={t("user:password.confirmPasswordPlaceholder")}
            />
            {errors.confirmPassword && (
              <p className="text-sm text-red-500">{errors.confirmPassword}</p>
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
              : t("user:password.confirmUpdate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
