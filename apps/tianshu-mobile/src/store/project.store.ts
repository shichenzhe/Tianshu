// 项目远端数据 store（A7 批）：hub（列表/搜索）/我的任务（listMine+前端
// 过滤）/详情（getDetail+成员并联）/计划（list+fields+views 并联+写操作族）/
// 资产（目录浏览+写操作族+readImage）五面。请求前经 请求序号+activeConnId
// +transport 三重校验 + project 能力/连接前置门禁（照 library.store 四重
// 范式）；写面经 enqueueWrite 串行，写后局部刷新（hub 写重拉 hub、计划写
// 重拉计划+我的任务、资产写重拉当前目录与用量）。
// 身份注记：wire 协议不透出当前用户 id——listMine 结果内按 assigneeId/
// createdById 众数推断 currentUserId（listMine 语义=指派给我 OR 我创建，
// 自任务的二元组里「我」必为众数）；推断不出（空列表）时范围过滤退化为
// 启发式（assigned=已指派行、created=未指派行），函数注释内明示。
import { create } from "zustand";
import {
  ENDPOINTS,
  PLAN_PRIORITIES,
  PLAN_STATUSES,
  type AssetEntryDto,
  type AssetStorageDto,
  type PlanFieldDefDto,
  type PlanItemAttachmentRecordDto,
  type PlanItemCreatePayload,
  type PlanItemRecordDto,
  type PlanItemUpdatePayload,
  type PlanStatus,
  type PlanViewRecordDto,
  type ProjectCreatePayload,
  type ProjectDetailResult,
  type ProjectMemberItemDto,
  type ProjectRecordDto,
} from "@tianshu/protocol";
import { wireRequest } from "../transport/wire";
import { activeTransport, useConnectionsStore } from "./connections.store";

export type TaskScope = "all" | "assigned" | "created";
export type TaskSource = "all" | "local" | "project";

interface FacetState {
  loading: boolean;
  error: string | null;
  initialized: boolean;
}

type FacetKey = "hub" | "tasks" | "detailFacet" | "plan" | "assets";

interface ProjectState {
  // —— hub 面 ——
  projects: ProjectRecordDto[];
  hubKeyword: string;
  hub: FacetState;
  // —— 我的任务面 ——
  mine: PlanItemRecordDto[];
  scope: TaskScope;
  source: TaskSource;
  tasksKeyword: string;
  /** wire 不透出用户 id：listMine 结果内推断（见头注释） */
  currentUserId: number | null;
  tasks: FacetState;
  // —— 详情面 ——
  currentProjectId: number | null;
  detail: ProjectDetailResult | null;
  members: ProjectMemberItemDto[];
  detailFacet: FacetState;
  // —— 计划面 ——
  items: PlanItemRecordDto[];
  fields: PlanFieldDefDto[];
  views: PlanViewRecordDto[];
  /** 本地记忆选中的视图 id；null = 按 sortOrder 首条 */
  activeViewId: number | null;
  plan: FacetState;
  // —— 资产面 ——
  entries: AssetEntryDto[];
  /** 面包屑段（相对项目资产根）；[] = 根 */
  folderPath: string[];
  storage: AssetStorageDto | null;
  assets: FacetState;
  saving: boolean;

  load(): Promise<void>;
  setHubKeyword(keyword: string): void;
  create(payload: ProjectCreatePayload): Promise<boolean>;
  rename(id: number, name: string): Promise<boolean>;
  updateInstruction(id: number, systemPrompt: string): Promise<boolean>;
  remove(id: number): Promise<boolean>;

  loadMine(): Promise<void>;
  setScope(scope: TaskScope): void;
  setSource(source: TaskSource): void;
  setTasksKeyword(keyword: string): void;

  loadDetail(projectId: number): Promise<void>;

  loadPlan(projectId: number): Promise<void>;
  setActiveView(id: number): void;
  createItem(payload: PlanItemCreatePayload): Promise<boolean>;
  updateItem(payload: PlanItemUpdatePayload): Promise<boolean>;
  /** 状态流转：跨列落点（sortOrder 由调用方按目标列计算） */
  moveItem(id: number, status: PlanStatus, sortOrder: number): Promise<boolean>;
  removeItem(id: number): Promise<boolean>;

  loadAssets(projectId: number, path?: string[]): Promise<void>;
  /** 不进面态的目录读取（附件「从资产挂接」挑文件用，不扰动浏览态） */
  peekAssets(projectId: number, path?: string[]): Promise<AssetEntryDto[]>;
  loadStorage(projectId: number): Promise<void>;
  createFolder(projectId: number, name: string): Promise<boolean>;
  renameAsset(
    projectId: number,
    path: string[],
    newName: string,
  ): Promise<boolean>;
  removeAsset(projectId: number, path: string[]): Promise<boolean>;
  readAssetImage(
    projectId: number,
    path: string[],
  ): Promise<{ mime: string; dataBase64: string }>;

  listAttachments(planItemId: number): Promise<PlanItemAttachmentRecordDto[]>;
  createAttachment(
    planItemId: number,
    fileName: string,
    assetPath: string,
  ): Promise<boolean>;
  removeAttachment(id: number): Promise<boolean>;

  resetForTest(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

const INITIAL_FACET: FacetState = {
  loading: false,
  error: null,
  initialized: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// —— DTO 容错解析（对齐 library.store：形状不符即 null，不半态入库） ——

function parseProject(value: unknown): ProjectRecordDto | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return value as unknown as ProjectRecordDto;
}

function parsePlanItem(value: unknown): PlanItemRecordDto | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.title !== "string" ||
    typeof value.status !== "string" ||
    !PLAN_STATUSES.includes(value.status as PlanItemRecordDto["status"]) ||
    typeof value.priority !== "string" ||
    !PLAN_PRIORITIES.includes(
      value.priority as PlanItemRecordDto["priority"],
    ) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }
  return value as unknown as PlanItemRecordDto;
}

function parseArray<T>(
  data: unknown,
  parse: (value: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(data)) return null;
  const items = data.map(parse);
  return items.every((item) => item !== null) ? (items as T[]) : null;
}

function parseDetail(data: unknown): ProjectDetailResult | null {
  if (!isRecord(data) || parseProject(data.project) === null) return null;
  if (!Array.isArray(data.bindings)) return null;
  return data as unknown as ProjectDetailResult;
}

function parseStorage(data: unknown): AssetStorageDto | null {
  if (
    !isRecord(data) ||
    typeof data.usedBytes !== "number" ||
    typeof data.quotaBytes !== "number"
  ) {
    return null;
  }
  return { usedBytes: data.usedBytes, quotaBytes: data.quotaBytes };
}

function parseAttachment(value: unknown): PlanItemAttachmentRecordDto | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "number" ||
    typeof value.planItemId !== "number" ||
    typeof value.fileName !== "string" ||
    typeof value.assetPath !== "string"
  ) {
    return null;
  }
  return value as unknown as PlanItemAttachmentRecordDto;
}

function parseImage(data: unknown): {
  mime: string;
  dataBase64: string;
} | null {
  if (
    !isRecord(data) ||
    typeof data.mime !== "string" ||
    typeof data.dataBase64 !== "string"
  ) {
    return null;
  }
  return { mime: data.mime, dataBase64: data.dataBase64 };
}

// —— 我的任务前端过滤（纯函数，页面/测试共用） ——

/** listMine 结果内推断当前用户 id：assigneeId/createdById 非空众数；
 *  空列表返回 null（范围过滤退化启发式，见 matchesScope） */
export function inferUserId(items: PlanItemRecordDto[]): number | null {
  const counts = new Map<number, number>();
  items.forEach((item) => {
    [item.assigneeId, item.createdById].forEach((id) => {
      if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
    });
  });
  let best: number | null = null;
  let bestCount = 0;
  counts.forEach((count, id) => {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  });
  return best;
}

function matchesScope(
  item: PlanItemRecordDto,
  scope: TaskScope,
  userId: number | null,
): boolean {
  if (scope === "assigned") {
    // userId 未知退化：已指派行（listMine 语义下绝大多数指派给我）
    return userId !== null
      ? item.assigneeId === userId
      : item.assigneeId !== null;
  }
  if (scope === "created") {
    // userId 未知退化：未指派行几乎都是自建（启发式）
    return userId !== null
      ? item.createdById === userId
      : item.assigneeId === null;
  }
  return true;
}

function matchesSource(item: PlanItemRecordDto, source: TaskSource): boolean {
  if (source === "local") return item.projectId === null;
  if (source === "project") return item.projectId !== null;
  return true;
}

/** 范围 + 来源 + 标题（大小写不敏感子串）三重过滤 */
export function filterMine(
  items: PlanItemRecordDto[],
  scope: TaskScope,
  source: TaskSource,
  keyword: string,
  userId: number | null,
): PlanItemRecordDto[] {
  const needle = keyword.trim().toLowerCase();
  return items.filter(
    (item) =>
      matchesScope(item, scope, userId) &&
      matchesSource(item, source) &&
      (needle === "" || item.title.toLowerCase().includes(needle)),
  );
}

/** 激活视图：本地记忆选中优先，否则 sortOrder 首条（id 兜底） */
export function resolveActiveView(
  views: PlanViewRecordDto[],
  activeViewId: number | null,
): PlanViewRecordDto | null {
  const sorted = [...views].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  );
  return sorted.find((view) => view.id === activeViewId) ?? sorted[0] ?? null;
}

// —— 四重防迟到门禁 + 写串行（照 library.store 同构） ——

let reqSeq = 0;
let writeChain: Promise<unknown> = Promise.resolve();
let pendingWrites = 0;

interface RequestToken {
  seq: number;
  connId: string | null;
  transport: ReturnType<typeof activeTransport>;
}

/** 请求前置四重门禁：活动连接存在 + project 能力已协商 + transport 可用，
 *  不满足不发请求（返回 null，调用方静默返回） */
function beginRequest(): RequestToken | null {
  const connId = useConnectionsStore.getState().activeConnId;
  if (!connId) return null;
  const capabilities =
    useConnectionsStore.getState().capabilitiesByConn[connId];
  if (!capabilities?.includes("project")) return null;
  const transport = activeTransport();
  if (!transport) return null;
  return { seq: ++reqSeq, connId, transport };
}

function isCurrentRequest(token: RequestToken): boolean {
  return (
    token.seq === reqSeq &&
    token.connId === useConnectionsStore.getState().activeConnId &&
    token.transport === activeTransport()
  );
}

export const useProjectStore = create<ProjectState>((set, get) => {
  /** 面级状态补丁（facet 字段名为动态键） */
  function patchFacet(facet: FacetKey, patch: Partial<FacetState>) {
    set((state) => ({ [facet]: { ...state[facet], ...patch } }));
  }

  /** 列表读取通用骨架：wire 请求 + 防迟到 + 业务错/形状不符置面 error；
   *  apply 在业务成功后把解析结果写入面（返回 false = 响应形状非法） */
  async function fetchInto(
    token: RequestToken,
    path: string,
    body: unknown,
    facet: FacetKey,
    apply: (data: unknown) => boolean,
  ): Promise<boolean> {
    patchFacet(facet, { loading: true, error: null });
    try {
      const result = await wireRequest("POST", path, body, token.transport);
      if (!isCurrentRequest(token)) return false;
      if (!result.ok) {
        patchFacet(facet, { error: result.message });
        return false;
      }
      if (!apply(result.data)) {
        patchFacet(facet, { error: "Invalid response" });
        return false;
      }
      patchFacet(facet, { error: null, initialized: true });
      return true;
    } catch (error) {
      if (isCurrentRequest(token)) {
        patchFacet(facet, { error: errorMessage(error) });
      }
      return false;
    } finally {
      if (isCurrentRequest(token)) patchFacet(facet, { loading: false });
    }
  }

  /** 单读请求（不进面态：附件列表等弹窗级数据；迟到/业务错返回 null） */
  async function fetchData(path: string, body: unknown): Promise<unknown> {
    const token = beginRequest();
    if (!token) return null;
    const result = await wireRequest("POST", path, body, token.transport);
    if (!isCurrentRequest(token)) return null;
    if (!result.ok) return null;
    return result.data;
  }

  /** 写面统一出口：串行排队 + saving 态 + 防迟到校验；写错置各面共享的
   *  hub.error（页面经 toast 消费）；refresh 为写后局部刷新回调 */
  async function enqueueWrite(
    path: string,
    body: unknown,
    refresh: () => void,
  ): Promise<boolean> {
    const token = beginRequest();
    if (!token) return false;
    pendingWrites += 1;
    set({ saving: true });
    const doWrite = async (): Promise<boolean> => {
      try {
        const result = await wireRequest("POST", path, body, token.transport);
        if (!isCurrentRequest(token)) return false;
        if (!result.ok) {
          patchFacet("hub", { error: result.message });
          return false;
        }
        refresh();
        return true;
      } catch (error) {
        if (isCurrentRequest(token)) {
          patchFacet("hub", { error: errorMessage(error) });
        }
        return false;
      } finally {
        pendingWrites -= 1;
        // 只由最后一项在途写清除；旧写迟到不得提前解锁后续写
        if (pendingWrites === 0) set({ saving: false });
      }
    };
    const queued = writeChain.then(doWrite);
    writeChain = queued;
    return queued;
  }

  /** 计划写后局部刷新：重拉当前项目计划面 + 我的任务（已初始化时） */
  function refreshPlanAfterWrite() {
    const { currentProjectId, tasks } = get();
    if (currentProjectId !== null) void get().loadPlan(currentProjectId);
    if (tasks.initialized) void get().loadMine();
  }

  /** 资产写后局部刷新：重拉当前目录 + 用量 */
  function refreshAssetsAfterWrite() {
    const { currentProjectId, folderPath } = get();
    if (currentProjectId === null) return;
    void get().loadAssets(currentProjectId, folderPath);
    void get().loadStorage(currentProjectId);
  }

  return {
    projects: [],
    hubKeyword: "",
    hub: { ...INITIAL_FACET },
    mine: [],
    scope: "all",
    source: "all",
    tasksKeyword: "",
    currentUserId: null,
    tasks: { ...INITIAL_FACET },
    currentProjectId: null,
    detail: null,
    members: [],
    detailFacet: { ...INITIAL_FACET },
    items: [],
    fields: [],
    views: [],
    activeViewId: null,
    plan: { ...INITIAL_FACET },
    entries: [],
    folderPath: [],
    storage: null,
    assets: { ...INITIAL_FACET },
    saving: false,

    load: async () => {
      const token = beginRequest();
      if (!token) return;
      await fetchInto(
        token,
        ENDPOINTS.project.query,
        null,
        "hub",
        (data) => {
          const projects = parseArray(data, parseProject);
          if (!projects) return false;
          set({ projects });
          return true;
        },
      );
    },

    setHubKeyword: (keyword) => set({ hubKeyword: keyword }),

    create: (payload) =>
      enqueueWrite(ENDPOINTS.project.create, payload, () => {
        void get().load();
      }),

    rename: (id, name) =>
      enqueueWrite(ENDPOINTS.project.update, { id, name }, () => {
        void get().load();
      }),

    updateInstruction: (id, systemPrompt) =>
      enqueueWrite(ENDPOINTS.project.update, { id, systemPrompt }, () => {
        void get().load();
      }),

    remove: (id) =>
      enqueueWrite(ENDPOINTS.project.delete, { id }, () => {
        void get().load();
      }),

    loadMine: async () => {
      const token = beginRequest();
      if (!token) return;
      await fetchInto(
        token,
        ENDPOINTS.planItem.listMine,
        null,
        "tasks",
        (data) => {
          const mine = parseArray(data, parsePlanItem);
          if (!mine) return false;
          // 顺带刷新用户 id 推断（范围过滤依赖）
          set({ mine, currentUserId: inferUserId(mine) });
          return true;
        },
      );
    },

    setScope: (scope) => set({ scope }),
    setSource: (source) => set({ source }),
    setTasksKeyword: (keyword) => set({ tasksKeyword: keyword }),

    loadDetail: async (projectId) => {
      const token = beginRequest();
      if (!token) return;
      set({ currentProjectId: projectId });
      patchFacet("detailFacet", { loading: true, error: null });
      try {
        // getDetail（含 bindings/assetWorkspaceId）+ 成员列表并联
        const [detailResult, membersResult] = await Promise.all([
          wireRequest(
            "POST",
            ENDPOINTS.project.getDetail,
            { id: projectId },
            token.transport,
          ),
          wireRequest(
            "POST",
            ENDPOINTS.project.listMembers,
            { projectId },
            token.transport,
          ),
        ]);
        if (!isCurrentRequest(token)) return;
        if (!detailResult.ok) {
          patchFacet("detailFacet", { error: detailResult.message });
          return;
        }
        if (!membersResult.ok) {
          patchFacet("detailFacet", { error: membersResult.message });
          return;
        }
        const detail = parseDetail(detailResult.data);
        const members = parseArray(membersResult.data, (value) =>
          isRecord(value) && typeof value.userId === "number"
            ? (value as unknown as ProjectMemberItemDto)
            : null,
        );
        if (!detail || !members) {
          patchFacet("detailFacet", { error: "Invalid response" });
          return;
        }
        set({ detail, members });
        patchFacet("detailFacet", {
          error: null,
          initialized: true,
          loading: false,
        });
      } catch (error) {
        if (isCurrentRequest(token)) {
          patchFacet("detailFacet", { error: errorMessage(error) });
        }
      } finally {
        if (isCurrentRequest(token)) {
          patchFacet("detailFacet", { loading: false });
        }
      }
    },

    loadPlan: async (projectId) => {
      const token = beginRequest();
      if (!token) return;
      set({ currentProjectId: projectId });
      patchFacet("plan", { loading: true, error: null });
      try {
        // 事项 + 字段定义 + 视图（含懒播种语义）三联并联
        const [itemsResult, fieldsResult, viewsResult] =
          await Promise.all([
            wireRequest(
              "POST",
              ENDPOINTS.planItem.list,
              { projectId },
              token.transport,
            ),
            wireRequest(
              "POST",
              ENDPOINTS.planItem.fieldsList,
              { projectId },
              token.transport,
            ),
            wireRequest(
              "POST",
              ENDPOINTS.planView.list,
              { projectId },
              token.transport,
            ),
          ]);
        if (!isCurrentRequest(token)) return;
        const planFailed = [itemsResult, fieldsResult, viewsResult].find(
          (result) => !result.ok,
        );
        if (planFailed) {
          patchFacet("plan", { error: planFailed.message });
          return;
        }
        if (!itemsResult.ok || !fieldsResult.ok || !viewsResult.ok) return;
        const items = parseArray(itemsResult.data, parsePlanItem);
        const fields = parseArray(
          fieldsResult.data,
          (value) =>
            isRecord(value) && typeof value.name === "string"
              ? (value as unknown as PlanFieldDefDto)
              : null,
        );
        const views = parseArray(
          viewsResult.data,
          (value) =>
            isRecord(value) && typeof value.id === "number"
              ? (value as unknown as PlanViewRecordDto)
              : null,
        );
        if (!items || !fields || !views) {
          patchFacet("plan", { error: "Invalid response" });
          return;
        }
        set({ items, fields, views });
        patchFacet("plan", { error: null, initialized: true, loading: false });
      } catch (error) {
        if (isCurrentRequest(token)) {
          patchFacet("plan", { error: errorMessage(error) });
        }
      } finally {
        if (isCurrentRequest(token)) patchFacet("plan", { loading: false });
      }
    },

    setActiveView: (id) => set({ activeViewId: id }),

    createItem: (payload) =>
      enqueueWrite(ENDPOINTS.planItem.create, payload, refreshPlanAfterWrite),

    updateItem: (payload) =>
      enqueueWrite(ENDPOINTS.planItem.update, payload, refreshPlanAfterWrite),

    moveItem: (id, status, sortOrder) =>
      enqueueWrite(
        ENDPOINTS.planItem.move,
        { id, status, sortOrder },
        refreshPlanAfterWrite,
      ),

    removeItem: (id) =>
      enqueueWrite(ENDPOINTS.planItem.delete, { id }, refreshPlanAfterWrite),

    loadAssets: async (projectId, path = []) => {
      const token = beginRequest();
      if (!token) return;
      set({ currentProjectId: projectId, folderPath: path });
      const body = path.length > 0 ? { projectId, path: path.join("/") } : { projectId };
      await fetchInto(
        token,
        ENDPOINTS.projectAsset.list,
        body,
        "assets",
        (data) => {
          const entries = parseArray(
            data,
            (value) =>
              isRecord(value) && typeof value.name === "string"
                ? (value as unknown as AssetEntryDto)
                : null,
          );
          if (!entries) return false;
          set({ entries });
          return true;
        },
      );
    },

    peekAssets: async (projectId, path = []) => {
      const body =
        path.length > 0 ? { projectId, path: path.join("/") } : { projectId };
      const data = await fetchData(ENDPOINTS.projectAsset.list, body);
      return parseArray(
        data,
        (value) =>
          isRecord(value) && typeof value.name === "string"
            ? (value as unknown as AssetEntryDto)
            : null,
      ) ?? [];
    },

    loadStorage: async (projectId) => {
      const token = beginRequest();
      if (!token) return;
      const data = await fetchData(ENDPOINTS.projectAsset.storage, {
        projectId,
      });
      const storage = parseStorage(data);
      if (storage) set({ storage });
    },

    createFolder: (projectId, name) =>
      enqueueWrite(
        ENDPOINTS.projectAsset.createFolder,
        { projectId, parentPath: get().folderPath.join("/"), name },
        refreshAssetsAfterWrite,
      ),

    renameAsset: (projectId, path, newName) =>
      enqueueWrite(
        ENDPOINTS.projectAsset.rename,
        { projectId, path: path.join("/"), newName },
        refreshAssetsAfterWrite,
      ),

    removeAsset: (projectId, path) =>
      enqueueWrite(
        ENDPOINTS.projectAsset.delete,
        { projectId, path: path.join("/") },
        refreshAssetsAfterWrite,
      ),

    readAssetImage: async (projectId, path) => {
      const data = await fetchData(ENDPOINTS.projectAsset.readImage, {
        projectId,
        path: path.join("/"),
      });
      const parsed = parseImage(data);
      if (!parsed) throw new Error("read image failed");
      return parsed;
    },

    listAttachments: async (planItemId) => {
      const data = await fetchData(ENDPOINTS.planItem.attachmentList, {
        planItemId,
      });
      return parseArray(data, parseAttachment) ?? [];
    },

    createAttachment: (planItemId, fileName, assetPath) =>
      enqueueWrite(
        ENDPOINTS.planItem.attachmentCreate,
        { planItemId, fileName, assetPath },
        () => {},
      ),

    removeAttachment: (id) =>
      enqueueWrite(ENDPOINTS.planItem.attachmentDelete, { id }, () => {}),

    resetForTest: () => {
      reqSeq += 1;
      writeChain = Promise.resolve();
      pendingWrites = 0;
      set({
        projects: [],
        hubKeyword: "",
        hub: { ...INITIAL_FACET },
        mine: [],
        scope: "all",
        source: "all",
        tasksKeyword: "",
        currentUserId: null,
        tasks: { ...INITIAL_FACET },
        currentProjectId: null,
        detail: null,
        members: [],
        detailFacet: { ...INITIAL_FACET },
        items: [],
        fields: [],
        views: [],
        activeViewId: null,
        plan: { ...INITIAL_FACET },
        entries: [],
        folderPath: [],
        storage: null,
        assets: { ...INITIAL_FACET },
        saving: false,
      });
    },
  };
});
