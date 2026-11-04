/**
 * 添加链接弹窗（树栏「+」菜单）：链接地址（必填，http/https）+ 链接
 * 标题（可选，缺省后端取域名）；空地址或非 http(s) 提交禁用；提交调
 * LibraryApi.addLink 由调用方失效缓存并 toast。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface LibraryLinkDialogProps {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (url: string, title: string | null) => void;
}

/** 前端轻校验（最终以后端 new URL + 协议白名单为准） */
const isHttpUrl = (value: string): boolean => /^https?:\/\/\S+$/.test(value);

export default function LibraryLinkDialog({
  open,
  submitting,
  onClose,
  onSubmit,
}: LibraryLinkDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setUrl("");
      setTitle("");
      setTouched(false);
    }
  }, [open]);

  const urlInvalid = touched && !isHttpUrl(url.trim());
  const canSubmit = isHttpUrl(url.trim()) && !submitting;

  const submit = () => {
    if (!canSubmit) {
      setTouched(true);
      return;
    }
    onSubmit(url.trim(), title.trim() || null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("chat:library.addLink")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-label={t("chat:library.linkAddress")}
              placeholder="https://"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  submit();
                }
              }}
            />
            {urlInvalid && (
              <p className="text-xs text-destructive">
                {t("chat:library.invalidLink")}
              </p>
            )}
          </div>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label={t("chat:library.linkTitle")}
            placeholder={t("chat:library.linkTitle")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t("common:cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
