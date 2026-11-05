// @vitest-environment jsdom
// queryKey 主机隔离（批3B，design §5 项1）：activeHost 归一进
// queryKeyHashFn——同 key 不同主机落不同缓存项（互不污染）、回切主机
// 缓存原地保留（秒开）；挂载中的观察者随主机切换跳新主机缓存项并重取。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../../src-react/domains/ai/data-source/host.store";
import {
  hostQueryToken,
  hostScopedQueryHash,
} from "../../../src-react/domains/ai/data-source/host-query";

/** 与 main.tsx 同款装配（主机隔离的 app 接线面） */
function scopedClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, queryKeyHashFn: hostScopedQueryHash },
    },
  });
}

beforeEach(() => {
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});
afterEach(cleanup);

describe("hostQueryToken", () => {
  it("本机与远程 connId 各自归一为稳定令牌", () => {
    expect(hostQueryToken({ kind: "local" })).toBe("local");
    expect(hostQueryToken({ kind: "remote", connId: "c1" })).toBe("conn:c1");
    expect(hostQueryToken({ kind: "remote", connId: "c2" })).toBe("conn:c2");
  });
});

describe("hostScopedQueryHash", () => {
  it("同 key 不同主机不同 hash；同主机稳定", () => {
    const local = hostScopedQueryHash(["sessions"]);
    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    const remote = hostScopedQueryHash(["sessions"]);
    expect(local).not.toBe(remote);
    expect(hostScopedQueryHash(["sessions"])).toBe(remote);
    // 对象键序不敏感（react-query hashKey 同构的稳定序列化）
    expect(hostScopedQueryHash(["m", { b: 1, a: 2 }])).toBe(
      hostScopedQueryHash(["m", { a: 2, b: 1 }]),
    );
  });
});

describe("QueryClient 主机隔离（同 key 不同主机不共享缓存）", () => {
  it("setQueryData/getQueryData 按主机路由；回切主机缓存保留", () => {
    const client = scopedClient();
    client.setQueryData(["sessions"], "local-data");

    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    expect(client.getQueryData(["sessions"])).toBeUndefined();
    client.setQueryData(["sessions"], "remote-data");
    // 两个主机各一条缓存项（不清不污染）
    expect(client.getQueryCache().getAll()).toHaveLength(2);

    useHostStore.setState({ activeHost: { kind: "local" } });
    expect(client.getQueryData(["sessions"])).toBe("local-data");
  });
});

/** 探针：挂载 query，queryFn 回读取数时刻的主机令牌 */
function Probe() {
  const { data } = useQuery({
    queryKey: ["probe"],
    queryFn: async () => `data:${hostQueryToken()}`,
  });
  return <div data-testid="probe">{data ?? "pending"}</div>;
}

describe("观察者随主机切换跳新主机缓存项", () => {
  it("切前 kick + 切 store：重取新主机数据；旧条目不被新主机数据污染；回切秒开", async () => {
    const client = scopedClient();
    render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("data:local")).toBeTruthy();

    // 切远程：kick 先行（switchToHost 时序——resetQueries 置空活动条目
    // data 必达 re-render + 旧条目刷新绑定旧主机），再切 store——观察者
    // 按新主机 hash 跳缓存项重取
    void client.resetQueries({ type: "active" });
    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("data:conn:c1"),
    );
    expect(client.getQueryData(["probe"])).toBe("data:conn:c1");

    // 回切本机（不 kick——纯读缓存）：本机条目仍是本机数据（若 kick 时
    // 序错位，旧条目会被 conn:c1 的取数污染成 "data:conn:c1"）
    useHostStore.setState({ activeHost: { kind: "local" } });
    expect(client.getQueryData(["probe"])).toBe("data:local");

    // kick + 本机：探针落回本机数据（缓存即时可见，后台刷新同值）
    void client.resetQueries({ type: "active" });
    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("data:local"),
    );
  });
});
