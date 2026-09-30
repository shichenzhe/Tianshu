/**
 * 连接器市场：工具栏（搜索 / 自定义连接器→管理弹窗）+ 24 卡片响应式
 * 网格（2/3/4 列）。已添加判定：DB name === 市场 id
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import McpServerApi from "../../api/mcp.api";
import { mapIpcError } from "../../chat/lib/error-message";
import type { McpServerJsonEntry } from "../lib/mcp-json";
import {
  MARKET_CONNECTORS,
  type MarketConnector,
} from "../lib/market-connectors";
import ConnectorCard from "../components/ConnectorCard";
import McpManageDialog from "../components/McpManageDialog";

const SERVERS_KEY = ["mcpServers"] as const;

export default function ConnectorMarketView() {
  const { t, i18n } = useTranslation(["ai", "common"]);
  const [search, setSearch] = useState("");
  const [manageOpen, setManageOpen] = useState(false);
  const [manageTemplate, setManageTemplate] = useState<
    Record<string, McpServerJsonEntry> | undefined
  >();

  const serversQuery = useQuery({
    queryKey: SERVERS_KEY,
    queryFn: () => McpServerApi.list(),
  });
  const installedIds = useMemo(
    () => new Set((serversQuery.data ?? []).map((server) => server.name)),
    [serversQuery.data],
  );

  const keyword = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      MARKET_CONNECTORS.filter(
        (c) =>
          c.name.toLowerCase().includes(keyword) ||
          i18n
            .t(`ai:mcp.connectors.${c.id}.description`)
            .toLowerCase()
            .includes(keyword),
      ),
    [keyword, i18n],
  );

  const openManage = (template?: Record<string, McpServerJsonEntry>) => {
    setManageTemplate(template);
    setManageOpen(true);
  };

  const openAdd = (connector: MarketConnector) => {
    openManage({ [connector.id]: connector.template });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("ai:mcp.market.searchPlaceholder")}
            className="pl-8"
          />
        </div>
        <Button
          variant="outline"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => openManage()}
        >
          <Plus className="mr-1 h-4 w-4" />
          {t("ai:mcp.market.customConnector")}
        </Button>
      </div>

      {serversQuery.isError ? (
        <p className="py-10 text-center text-sm text-destructive">
          {mapIpcError(serversQuery.error)}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {visible.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              added={installedIds.has(connector.id)}
              onAdd={openAdd}
            />
          ))}
        </div>
      )}

      <McpManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        initialTemplate={manageTemplate}
      />
    </div>
  );
}
