import { useQuery } from "@tanstack/react-query";
import { ProviderApi } from "../../api/provider.api";
import { ModelApi } from "../../api/model.api";
import type { SessionRecord } from "../../api/session.api";
import { WorkspaceApi, type WorkspaceRecord } from "../../api/workspace.api";
import { useHostStore } from "../../data-source/host.store";

interface SessionPaneDataOptions {
  /** 普通聊天无选中会话时沿用第一空间；运行视图禁止此隐式回退。 */
  fallBackToFirstWorkspace?: boolean;
}

/** 普通会话与运行会话共用的模型、空间和模型可用性规则。 */
export function useSessionPaneData(
  selectedSession: SessionRecord | null,
  options: SessionPaneDataOptions = {},
) {
  const providersQuery = useQuery({
    queryKey: ["providers"],
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: () => ModelApi.listAll(),
  });
  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
  });
  const isRemoteHost = useHostStore(
    (state) => state.activeHost.kind === "remote",
  );
  const providers = providersQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  const workspaces = workspacesQuery.data ?? [];
  const activeWorkspace =
    workspaces.find(
      (workspace) => workspace.id === selectedSession?.workspaceId,
    ) ?? null;
  const workspace = resolvePaneWorkspace(
    selectedSession,
    activeWorkspace,
    workspaces,
    isRemoteHost,
    options.fallBackToFirstWorkspace ?? true,
  );
  const hasConfiguredModel = Boolean(
    selectedSession?.currentModelId ?? activeWorkspace?.defaultModelId,
  );
  const hasModel = selectedSession
    ? hasConfiguredModel ||
      (isRemoteHost &&
        models.some((model) => model.enabled && model.type === "llm"))
    : false;
  const needsSetup =
    providersQuery.isSuccess &&
    modelsQuery.isSuccess &&
    providers.length === 0 &&
    models.length === 0;

  return {
    providersQuery,
    modelsQuery,
    workspacesQuery,
    models,
    workspaces,
    activeWorkspace,
    workspace,
    hasModel,
    needsSetup,
  };
}

function resolvePaneWorkspace(
  session: SessionRecord | null,
  activeWorkspace: WorkspaceRecord | null,
  workspaces: WorkspaceRecord[],
  isRemoteHost: boolean,
  fallBackToFirstWorkspace: boolean,
): Pick<WorkspaceRecord, "id"> | null {
  if (isRemoteHost) return null;
  if (activeWorkspace) return activeWorkspace;
  const hasExplicitWorkspace = (session?.workspaceId ?? 0) > 0;
  if (
    hasExplicitWorkspace &&
    (session?.projectId != null || !fallBackToFirstWorkspace)
  ) {
    return { id: session!.workspaceId };
  }
  return fallBackToFirstWorkspace ? (workspaces[0] ?? null) : null;
}

export function sessionSettingsPath(
  target: "providers" | "assistants" | "mcp",
): string {
  if (target === "providers") return "/module/ai/providers";
  if (target === "assistants") return "/module/ai/experts";
  return "/module/ai/experts?tab=connectors";
}
