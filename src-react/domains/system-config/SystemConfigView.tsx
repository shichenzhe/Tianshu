/**
 * 系统配置视图（占位符版本）
 * TODO: 完整实现需要迁移 system-config.vue 的所有功能
 */

import { useState, useEffect } from "react";
import { Plus, Trash2, Edit } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { OptionApi } from "@/domains/system-config/api/option.api";
import type { OptionItem } from "@/domains/system-config/model/option";

import PageTitle from "@/components/layout/PageTitle";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

export default function SystemConfigView() {
  const { t } = useTranslation(["system-config", "common"]);
  const [options, setOptions] = useState<OptionItem[]>([]);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [currentOption, setCurrentOption] = useState<OptionItem>({
    value: "",
    name: "",
    note: "",
  });
  const [selectedOption, setSelectedOption] = useState<OptionItem | null>(null);
  const [loading, setLoading] = useState(false);

  // 加载系统配置
  const loadOptions = async () => {
    try {
      const data = await OptionApi.listByType({ type: "system" });
      setOptions(data);
    } catch (error) {
      console.error("加载系统配置失败:", error);
      toast.error(t("system-config:loadFailed"));
    }
  };

  useEffect(() => {
    loadOptions();
  }, []);

  // 打开新增对话框
  const handleOpenAddDialog = () => {
    setCurrentOption({ value: "", name: "", note: "" });
    setAddDialogOpen(true);
  };

  // 打开编辑对话框
  const handleOpenEditDialog = (option: OptionItem) => {
    setSelectedOption(option);
    setCurrentOption(option);
    setEditDialogOpen(true);
  };

  // 添加配置
  const handleAdd = async () => {
    if (!currentOption.value || !currentOption.name) {
      toast.warning(t("system-config:valueRequired"));
      return;
    }

    setLoading(true);
    try {
      await OptionApi.create({
        type: "system",
        ...currentOption,
      });
      toast.success(t("system-config:addSuccess"));
      setAddDialogOpen(false);
      loadOptions();
    } catch (error) {
      console.error("添加配置失败:", error);
      toast.error(t("system-config:addFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 更新配置
  const handleUpdate = async () => {
    if (!selectedOption) return;

    // 验证配置值不能为空
    if (!currentOption.value) {
      toast.warning(t("system-config:valueOnlyRequired"));
      return;
    }

    setLoading(true);
    try {
      await OptionApi.update({
        type: "system",
        name: selectedOption.name,
        value: currentOption.value,
        note: currentOption.note,
      });
      toast.success(t("system-config:updateSuccess"));
      setEditDialogOpen(false);
      setSelectedOption(null);
      loadOptions();
    } catch (error) {
      console.error("更新配置失败:", error);
      toast.error(t("system-config:updateFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 删除配置
  const handleDelete = async () => {
    if (!selectedOption) return;

    setLoading(true);
    try {
      await OptionApi.delete({
        type: "system",
        name: selectedOption.name,
      });
      toast.success(t("system-config:deleteSuccess"));
      setDeleteDialogOpen(false);
      setSelectedOption(null);
      loadOptions();
    } catch (error) {
      console.error("删除配置失败:", error);
      toast.error(t("system-config:deleteFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-2">
      <PageTitle title={t("system-config:pageTitle")} />

      {/* 工具栏 */}
      <div className="mb-4">
        <Button onClick={handleOpenAddDialog} size="sm">
          <Plus className="w-4 h-4 mr-1" />
          {t("system-config:addConfig")}
        </Button>
      </div>

      {/* 配置列表 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 text-center">
                {t("common:serialNo")}
              </TableHead>
              <TableHead>{t("system-config:configName")}</TableHead>
              <TableHead>{t("system-config:configValue")}</TableHead>
              <TableHead>{t("system-config:remark")}</TableHead>
              <TableHead className="w-32">{t("common:operation")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {options.map((option, index) => (
              <TableRow
                key={option.name}
                className={cn(
                  "cursor-pointer",
                  selectedOption?.name === option.name && "bg-primary-subtle",
                )}
                onClick={() => setSelectedOption(option)}
              >
                <TableCell className="text-center text-gray-500">
                  {index + 1}
                </TableCell>
                <TableCell className="font-medium">{option.name}</TableCell>
                <TableCell className="font-mono text-sm">
                  {option.value}
                </TableCell>
                <TableCell className="text-gray-500">
                  {option.note || "-"}
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenEditDialog(option);
                      }}
                      className="h-8"
                    >
                      <Edit className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedOption(option);
                        setDeleteDialogOpen(true);
                      }}
                      className="h-8 w-8 p-0"
                    >
                      <Trash2 className="w-3 h-3 text-red-500" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {options.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-gray-400 py-8"
                >
                  {t("system-config:emptyHint")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 新增对话框 */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("system-config:addDialog.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="add-name">{t("system-config:configName")}</Label>
              <Input
                id="add-name"
                value={currentOption.name}
                onChange={(e) =>
                  setCurrentOption({ ...currentOption, name: e.target.value })
                }
                placeholder={t("system-config:addDialog.namePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="add-value">
                {t("system-config:configValue")}
              </Label>
              <Input
                id="add-value"
                value={currentOption.value}
                onChange={(e) =>
                  setCurrentOption({ ...currentOption, value: e.target.value })
                }
                placeholder={t("system-config:addDialog.valuePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="add-note">{t("system-config:remark")}</Label>
              <Textarea
                id="add-note"
                value={currentOption.note || ""}
                onChange={(e) =>
                  setCurrentOption({ ...currentOption, note: e.target.value })
                }
                placeholder={t("system-config:addDialog.remarkPlaceholder")}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleAdd} disabled={loading}>
              {loading
                ? t("system-config:addDialog.adding")
                : t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑对话框 */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("system-config:editDialog.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label>{t("system-config:configName")}</Label>
              <Input value={selectedOption?.name || ""} disabled />
            </div>
            <div>
              <Label htmlFor="edit-value">
                {t("system-config:configValue")}
              </Label>
              <Input
                id="edit-value"
                value={currentOption.value}
                onChange={(e) =>
                  setCurrentOption({ ...currentOption, value: e.target.value })
                }
                placeholder={t("system-config:editDialog.valuePlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="edit-note">{t("system-config:remark")}</Label>
              <Textarea
                id="edit-note"
                value={currentOption.note || ""}
                onChange={(e) =>
                  setCurrentOption({ ...currentOption, note: e.target.value })
                }
                placeholder={t("system-config:editDialog.remarkPlaceholder")}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleUpdate} disabled={loading}>
              {loading
                ? t("system-config:editDialog.updating")
                : t("common:confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认对话框 */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common:confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("system-config:deleteConfirm", { name: selectedOption?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
