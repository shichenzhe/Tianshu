/**
 * 服务商预设模板（spec §5：精选 8 家静态常量，扩展加一行）
 */
import type { ProviderType } from "../../api/provider.api";

export interface ProviderPreset {
  label: string;
  type: ProviderType;
  baseUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: "DeepSeek",
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    label: "Kimi（月之暗面）",
    type: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    label: "通义千问（Qwen）",
    type: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    label: "智谱 GLM",
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    label: "OpenAI",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    label: "Anthropic Claude",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  {
    label: "Google Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    label: "Ollama（本地）",
    type: "ollama",
    baseUrl: "http://localhost:11434",
  },
];
