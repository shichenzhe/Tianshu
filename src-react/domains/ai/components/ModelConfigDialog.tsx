/**
 * 模型配置对话框
 */

import { useState, useEffect } from "react";
import {
  Plus,
  Edit,
  Trash2,
  Settings,
  Link,
  Clock,
  Check,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  ModelConfigApi,
  type ModelConfigRecord,
  type ModelConfigCreateParams,
  type ModelConfigUpdateParams,
} from "@/domains/ai/api/model-config.api";

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
import { Badge } from "@/components/ui/badge";
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
import { DateTimeUtil } from "@/lib/utils";

interface ModelConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// 模型选项（用于下拉建议）
const modelOptions = [
  "gpt-4",
  "gpt-4-turbo",
  "gpt-4o",
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-16k",
  "claude-3-opus",
  "claude-3-sonnet",
  "claude-3-haiku",
  "gemini-pro",
  "gemini-pro-vision",
];

// 初始表单数据
const initialFormData = {
  name: "",
  apiKey: "",
  modelName: "gpt-3.5-turbo",
  baseUrl: "",
  isActive: false,
};

export function ModelConfigDialog({
  open,
  onOpenChange,
}: ModelConfigDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  // 状态
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [configList, setConfigList] = useState<ModelConfigRecord[]>([]);

  // 表单对话框状态
  const [showForm, setShowForm] = useState(false);
  const [isEdit, setIsEdit] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [formData, setFormData] = useState(initialFormData);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // 删除确认对话框
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [configToDelete, setConfigToDelete] =
    useState<ModelConfigRecord | null>(null);

  // 加载配置列表
  const loadConfigs = async () => {
    setLoading(true);
    try {
      const list = await ModelConfigApi.list();
      setConfigList(list);
    } catch (error) {
      console.error("加载模型配置失败:", error);
      toast.error(t("ai:modelConfig.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  // 对话框打开时加载数据
  useEffect(() => {
    if (open) {
      loadConfigs();
    }
  }, [open]);

  // 格式化日期
  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString(DateTimeUtil.getLocale());
  };

  // 打开添加表单
  const handleAdd = () => {
    setIsEdit(false);
    setEditId(null);
    setFormData(initialFormData);
    setFormErrors({});
    setShowForm(true);
  };

  // 打开编辑表单
  const handleEdit = (config: ModelConfigRecord) => {
    setIsEdit(true);
    setEditId(config.id);
    setFormData({
      name: config.name,
      apiKey: config.apiKey,
      modelName: config.modelName,
      baseUrl: config.baseUrl || "",
      isActive: config.isActive,
    });
    setFormErrors({});
    setShowForm(true);
  };

  // 确认删除
  const handleDeleteConfirm = (config: ModelConfigRecord) => {
    setConfigToDelete(config);
    setDeleteDialogOpen(true);
  };

  // 执行删除
  const handleDelete = async () => {
    if (!configToDelete) return;
    try {
      await ModelConfigApi.delete(configToDelete.id);
      toast.success(t("ai:modelConfig.deleteSuccess"));
      setDeleteDialogOpen(false);
      setConfigToDelete(null);
      loadConfigs();
    } catch (error) {
      console.error("删除失败:", error);
      toast.error(t("ai:modelConfig.deleteFailed"));
    }
  };

  // 设置激活
  const handleSetActive = async (config: ModelConfigRecord) => {
    try {
      await ModelConfigApi.setActive(config.id);
      toast.success(t("ai:modelConfig.activateSuccess"));
      loadConfigs();
    } catch (error) {
      console.error("激活失败:", error);
      toast.error(t("ai:modelConfig.activateFailed"));
    }
  };

  // 表单验证
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.name.trim()) {
      errors.name = t("ai:modelConfig.configNameRequired");
    } else if (formData.name.length < 2 || formData.name.length > 50) {
      errors.name = t("ai:modelConfig.configNameLength");
    }

    if (!formData.apiKey.trim()) {
      errors.apiKey = t("ai:modelConfig.apiKeyRequired");
    } else if (formData.apiKey.length < 10) {
      errors.apiKey = t("ai:modelConfig.apiKeyLength");
    }

    if (!formData.modelName.trim()) {
      errors.modelName = t("ai:modelConfig.modelNameRequired");
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // 提交表单
  const handleSubmit = async () => {
    if (!validateForm()) return;

    setSubmitting(true);
    try {
      if (isEdit && editId) {
        const params: ModelConfigUpdateParams = {
          id: editId,
          name: formData.name,
          apiKey: formData.apiKey,
          modelName: formData.modelName,
          baseUrl: formData.baseUrl || undefined,
        };
        await ModelConfigApi.update(params);
        toast.success(t("ai:modelConfig.updateSuccess"));
      } else {
        const params: ModelConfigCreateParams = {
          name: formData.name,
          apiKey: formData.apiKey,
          modelName: formData.modelName,
          baseUrl: formData.baseUrl || undefined,
        };
        await ModelConfigApi.create(params);
        toast.success(t("ai:modelConfig.createSuccess"));
      }

      // 如果设置为激活，则激活该配置
      if (formData.isActive && !isEdit) {
        const list = await ModelConfigApi.list();
        const newConfig = list.find((c) => c.name === formData.name);
        if (newConfig) {
          await ModelConfigApi.setActive(newConfig.id);
        }
      }

      setShowForm(false);
      loadConfigs();
    } catch (error) {
      console.error("保存失败:", error);
      toast.error(t("ai:modelConfig.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  // 关闭表单
  const handleFormClose = () => {
    setShowForm(false);
    setFormData(initialFormData);
    setFormErrors({});
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[800px] max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("ai:modelConfig.title")}</DialogTitle>
          </DialogHeader>

          <div className="py-4 min-h-[400px]">
            {/* 头部 */}
            <div className="flex items-center justify-between pb-4 mb-4 border-b">
              <h3 className="text-lg font-semibold text-gray-900">
                {t("ai:modelConfig.configuredModels")}
              </h3>
              <Button onClick={handleAdd}>
                <Plus className="w-4 h-4 mr-1" />
                {t("ai:modelConfig.addConfig")}
              </Button>
            </div>

            {/* 配置列表 */}
            {loading ? (
              <div className="flex items-center justify-center py-16 text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin mr-2" />
                {t("common:loading")}
              </div>
            ) : configList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                <p className="text-lg mb-4">{t("ai:modelConfig.noConfig")}</p>
                <Button onClick={handleAdd}>
                  <Plus className="w-4 h-4 mr-1" />
                  {t("ai:modelConfig.addFirst")}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {configList.map((config) => (
                  <div
                    key={config.id}
                    className={`flex items-center justify-between p-4 rounded-lg border transition-colors ${
                      config.isActive
                        ? "bg-blue-50 border-blue-500"
                        : "bg-gray-50 border-gray-200 hover:bg-gray-100"
                    }`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h4 className="font-semibold text-gray-900">
                          {config.name}
                        </h4>
                        {config.isActive ? (
                          <Badge className="bg-green-500">
                            {t("ai:modelConfig.currentActive")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            {t("ai:modelConfig.inactive")}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-4 text-sm text-gray-500">
                        <span className="flex items-center gap-1">
                          <Settings className="w-4 h-4" />
                          {config.modelName}
                        </span>
                        {config.baseUrl && (
                          <span className="flex items-center gap-1">
                            <Link className="w-4 h-4" />
                            {config.baseUrl}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Clock className="w-4 h-4" />
                          {formatDate(config.createdAt)}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      {!config.isActive && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSetActive(config)}
                          className="text-green-600 border-green-600 hover:bg-green-50"
                        >
                          <Check className="w-4 h-4 mr-1" />
                          {t("ai:modelConfig.activate")}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEdit(config)}
                      >
                        <Edit className="w-4 h-4 mr-1" />
                        {t("common:edit")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteConfirm(config)}
                        disabled={config.isActive}
                        className="text-red-600 border-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {t("common:delete")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common:close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 添加/编辑表单对话框 */}
      <Dialog open={showForm} onOpenChange={handleFormClose}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>
              {isEdit
                ? t("ai:modelConfig.editConfig")
                : t("ai:modelConfig.addConfigTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="name">
                {t("ai:modelConfig.configName")}{" "}
                <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder={t("ai:modelConfig.configNamePlaceholder")}
                maxLength={50}
                className={formErrors.name ? "border-red-500" : ""}
              />
              {formErrors.name && (
                <p className="text-sm text-red-500 mt-1">{formErrors.name}</p>
              )}
            </div>

            <div>
              <Label htmlFor="apiKey">
                {t("ai:modelConfig.apiKey")}{" "}
                <span className="text-red-500">*</span>
              </Label>
              <Input
                id="apiKey"
                type="password"
                value={formData.apiKey}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, apiKey: e.target.value }))
                }
                placeholder={t("ai:modelConfig.apiKeyPlaceholder")}
                className={formErrors.apiKey ? "border-red-500" : ""}
              />
              {formErrors.apiKey && (
                <p className="text-sm text-red-500 mt-1">{formErrors.apiKey}</p>
              )}
            </div>

            <div>
              <Label htmlFor="modelName">
                {t("ai:modelConfig.modelName")}{" "}
                <span className="text-red-500">*</span>
              </Label>
              <Input
                id="modelName"
                value={formData.modelName}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    modelName: e.target.value,
                  }))
                }
                placeholder={t("ai:modelConfig.modelNamePlaceholder")}
                list="model-options"
                className={formErrors.modelName ? "border-red-500" : ""}
              />
              <datalist id="model-options">
                {modelOptions.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              {formErrors.modelName && (
                <p className="text-sm text-red-500 mt-1">
                  {formErrors.modelName}
                </p>
              )}
              <p className="text-xs text-gray-500 mt-1">
                {t("ai:modelConfig.commonModels")}
                {modelOptions.slice(0, 5).join(", ")} {t("ai:modelConfig.etc")}
              </p>
            </div>

            <div>
              <Label htmlFor="baseUrl">{t("ai:modelConfig.baseUrl")}</Label>
              <Input
                id="baseUrl"
                value={formData.baseUrl}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, baseUrl: e.target.value }))
                }
                placeholder={t("ai:modelConfig.baseUrlPlaceholder")}
              />
            </div>

            {!isEdit && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={formData.isActive}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      isActive: e.target.checked,
                    }))
                  }
                  className="w-4 h-4 rounded border-gray-300"
                />
                <Label htmlFor="isActive" className="cursor-pointer">
                  {t("ai:modelConfig.setActive")}
                </Label>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleFormClose}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  {t("common:saving")}
                </>
              ) : isEdit ? (
                t("common:update")
              ) : (
                t("common:create")
              )}
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
              {t("ai:modelConfig.deleteConfirm", {
                name: configToDelete?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default ModelConfigDialog;
