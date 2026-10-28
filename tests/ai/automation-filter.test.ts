// tests/ai/automation-filter.test.ts
import { describe, expect, it } from "vitest";
import { filterTasks } from "../../src-react/domains/ai/automation/store/automation.store";
import type { TaskRecord } from "../../src-react/domains/ai/automation/api/automation.api";

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  id: 1,
  name: "早报",
  prompt: "p",
  workspaceId: 1,
  workspaceName: "w",
  source: "project",
  modelId: 1,
  scheduleJson: "{}",
  scheduleText: "每天 09:00",
  missedPolicy: "skip",
  enabled: true,
  status: "active",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  ...over,
});

const tasks = [
  task({
    id: 1,
    name: "AI 早报",
    source: "project",
    enabled: true,
    status: "active",
  }),
  task({
    id: 2,
    name: "周报",
    source: "local",
    enabled: false,
    status: "active",
  }),
  task({
    id: 3,
    name: "监控",
    source: "local",
    enabled: false,
    status: "error",
  }),
];

describe("filterTasks", () => {
  it("source 维度:cloud 恒空", () => {
    expect(filterTasks(tasks, "cloud", "all", "").length).toBe(0);
    expect(filterTasks(tasks, "local", "all", "").length).toBe(2);
    expect(filterTasks(tasks, "project", "all", "").length).toBe(1);
  });
  it("status 维度:running=enabled&&active;paused=!enabled&&active", () => {
    expect(filterTasks(tasks, "all", "running", "").map((t) => t.id)).toEqual([
      1,
    ]);
    expect(filterTasks(tasks, "all", "paused", "").map((t) => t.id)).toEqual([
      2,
    ]);
    expect(filterTasks(tasks, "all", "error", "").map((t) => t.id)).toEqual([
      3,
    ]);
  });
  it("search 名称包含(大小写不敏感)", () => {
    expect(filterTasks(tasks, "all", "all", "ai").map((t) => t.id)).toEqual([
      1,
    ]);
    expect(filterTasks(tasks, "all", "all", "不存在")).toEqual([]);
  });
});
