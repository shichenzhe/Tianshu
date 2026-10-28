// @vitest-environment jsdom
// useHostCaps hook（HD-T4，spec §2.4）：组件门控数据源——初值本地全集，
// switchHost 切远程后响应式更新（空面——caps 由切换入口回填真实值）。
// capsOfCapabilities 推导面已在 host-route.test.ts 覆盖，此处只测 hook 直通。
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  useHostCaps,
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../../src-react/domains/ai/data-source/host.store";

afterEach(() => {
  cleanup();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("useHostCaps", () => {
  it("初值：本地主机全集（files=true）", () => {
    const { result } = renderHook(() => useHostCaps());
    expect(result.current).toEqual(LOCAL_HOST_CAPS);
    expect(result.current.files).toBe(true);
  });

  it("switchHost 切远程：caps 响应式更新为空面（files=false）", () => {
    const { result, rerender } = renderHook(() => useHostCaps());
    act_switchRemote();
    rerender();
    expect(result.current.files).toBe(false);
    // 切回本地恢复全集
    useHostStore.getState().switchHost({ kind: "local" });
    rerender();
    expect(result.current.files).toBe(true);
  });
});

function act_switchRemote() {
  useHostStore.getState().switchHost({ kind: "remote", connId: "gate-c1" });
}
