/**
 * 连接器市场静态清单（PRD 24 项）：id 为 JSON 模板 key 与「已添加」匹配键
 * （DB name === id 即已添加），name 仅展示；图标用 lucide（无品牌资产版权）；
 * 模板为占位骨架（spec 假设：真实配置无公开权威来源，整体替换本文件即可）
 */
import {
  Bell,
  BookOpen,
  Building2,
  CandlestickChart,
  ClipboardList,
  Cloud,
  Database,
  Eye,
  Feather,
  FileSpreadsheet,
  FileText,
  Gift,
  GitBranch,
  Globe,
  HardDrive,
  KanbanSquare,
  Library,
  LineChart,
  Mail,
  MessageSquare,
  Newspaper,
  Scale,
  TrendingUp,
  Video,
  type LucideIcon,
} from "lucide-react";

import type { McpServerJsonEntry } from "./mcp-json";

export interface MarketConnector {
  id: string;
  name: string;
  icon: LucideIcon;
  template: McpServerJsonEntry;
}

/** stdio 骨架：本地/CLI 型连接器 */
function stdio(pkg: string, envKey?: string): McpServerJsonEntry {
  return {
    command: "npx",
    args: ["-y", pkg],
    ...(envKey ? { env: { [envKey]: "YOUR_API_KEY" } } : {}),
  };
}

/** http 骨架：数据服务型连接器 */
function http(host: string): McpServerJsonEntry {
  return {
    url: `https://${host}/mcp`,
    headers: { Authorization: "Bearer YOUR_TOKEN" },
  };
}

export const MARKET_CONNECTORS: MarketConnector[] = [
  {
    id: "tongdaxin",
    name: "通达信",
    icon: TrendingUp,
    template: http("mcp.tongdaxin.example"),
  },
  {
    id: "tencent-stock",
    name: "腾讯自选股",
    icon: LineChart,
    template: http("mcp.zixuangu.example"),
  },
  { id: "qq-mail", name: "QQ邮箱", icon: Mail, template: stdio("qq-mail-mcp") },
  { id: "ima", name: "ima", icon: BookOpen, template: stdio("ima-mcp") },
  {
    id: "lexiang",
    name: "乐享知识库",
    icon: Library,
    template: stdio("lexiang-mcp", "LEXIANG_TOKEN"),
  },
  {
    id: "tencent-docs",
    name: "腾讯文档",
    icon: FileText,
    template: stdio("tencent-docs-mcp", "TENCENT_DOCS_TOKEN"),
  },
  {
    id: "tencent-meeting",
    name: "腾讯会议",
    icon: Video,
    template: stdio("tencent-meeting-mcp", "MEETING_SDK_ID"),
  },
  {
    id: "wecom",
    name: "企业微信",
    icon: MessageSquare,
    template: stdio("wecom-mcp", "WECOM_CORP_ID"),
  },
  {
    id: "feishu",
    name: "飞书",
    icon: Feather,
    template: stdio("@larksuiteoapi/lark-mcp", "FEISHU_APP_ID"),
  },
  {
    id: "dingtalk",
    name: "钉钉",
    icon: Bell,
    template: stdio("dingtalk-mcp", "DINGTALK_TOKEN"),
  },
  {
    id: "tencent-survey",
    name: "腾讯问卷",
    icon: ClipboardList,
    template: stdio("tencent-survey-mcp", "SURVEY_TOKEN"),
  },
  {
    id: "tapd",
    name: "TAPD",
    icon: KanbanSquare,
    template: stdio("tapd-mcp", "TAPD_TOKEN"),
  },
  {
    id: "neodata",
    name: "NeoData金融数据库",
    icon: Database,
    template: http("mcp.neodata.example"),
  },
  {
    id: "cnb",
    name: "CNB",
    icon: GitBranch,
    template: stdio("cnb-mcp", "CNB_TOKEN"),
  },
  {
    id: "weiyun",
    name: "微云",
    icon: Cloud,
    template: stdio("weiyun-mcp", "WEIYUN_TOKEN"),
  },
  {
    id: "fubangshou",
    name: "福帮手",
    icon: Gift,
    template: stdio("fubangshou-mcp"),
  },
  {
    id: "jinshan-docs",
    name: "金山文档|WPS云文档",
    icon: FileSpreadsheet,
    template: stdio("wps-mcp", "WPS_TOKEN"),
  },
  {
    id: "beida-fabao",
    name: "北大法宝·法律智能检索",
    icon: Scale,
    template: http("mcp.pkulaw.example"),
  },
  {
    id: "qichacha",
    name: "企查查",
    icon: Building2,
    template: http("mcp.qcc.example"),
  },
  {
    id: "tianyancha",
    name: "天眼查",
    icon: Eye,
    template: http("mcp.tianyancha.example"),
  },
  {
    id: "baidu-netdisk",
    name: "百度网盘",
    icon: HardDrive,
    template: http("mcp.netdisk.example"),
  },
  {
    id: "tushare",
    name: "Tushare",
    icon: CandlestickChart,
    template: http("mcp.tushare.example"),
  },
  {
    id: "dun-bradstreet",
    name: "邓白氏寰球全球",
    icon: Globe,
    template: http("mcp.dnb.example"),
  },
  {
    id: "xinhua-finance",
    name: "新华财经资讯MCP",
    icon: Newspaper,
    template: http("mcp.xinhua.example"),
  },
];
