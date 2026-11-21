// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

const listeners = vi.hoisted(
  () => new Map<string, Set<(event: unknown, payload?: unknown) => void>>(),
);

vi.mock("@/lib/ipc", () => ({
  on: (
    channel: string,
    listener: (event: unknown, payload?: unknown) => void,
  ) => {
    const channelListeners = listeners.get(channel) ?? new Set();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return () => channelListeners.delete(listener);
  },
}));

import { registerQueryInvalidation } from "../../src-react/lib/query-invalidate-events";
import { AUTOMATION_CHANGED_EVENT } from "../../src-react/domains/ai/automation/api/automation.api";
import { SESSION_CHANGED_EVENT } from "../../src-react/domains/ai/api/session.api";
import {
  LOCAL_HOST_CAPS,
  useHostStore,
} from "../../src-react/domains/ai/data-source/host.store";

const RUN_SESSION_KEYS = [
  ["automation", "runGroups"],
  ["automation", "run", 9],
  ["sessions", "all"],
] as const;

function emit(channel: string, payload?: unknown): void {
  for (const listener of listeners.get(channel) ?? []) {
    listener({}, payload);
  }
}

function seedRunSessionQueries(client: QueryClient): void {
  for (const key of RUN_SESSION_KEYS) {
    client.setQueryData([...key], { stale: false });
  }
}

function expectRunSessionQueriesInvalidated(client: QueryClient): void {
  for (const key of RUN_SESSION_KEYS) {
    expect(client.getQueryState([...key])?.isInvalidated).toBe(true);
  }
}

describe("registerQueryInvalidation run sessions", () => {
  beforeEach(() => {
    listeners.clear();
    useHostStore.setState({
      activeHost: { kind: "local" },
      caps: LOCAL_HOST_CAPS,
    });
  });

  it("本地 automation/session 与远程三类事件都失效分组、run 详情和会话", () => {
    const client = new QueryClient();
    registerQueryInvalidation(client);

    seedRunSessionQueries(client);
    emit(AUTOMATION_CHANGED_EVENT);
    expectRunSessionQueriesInvalidated(client);

    seedRunSessionQueries(client);
    emit(SESSION_CHANGED_EVENT);
    expectRunSessionQueriesInvalidated(client);

    useHostStore.setState({
      activeHost: { kind: "remote", connId: "conn-1" },
      caps: LOCAL_HOST_CAPS,
    });
    for (const type of [
      "automation.changed",
      "graph.run.updated",
      "session.updated",
    ]) {
      seedRunSessionQueries(client);
      emit("server:event:conn-1", { type, payload: {} });
      expectRunSessionQueriesInvalidated(client);
    }
  });
});
