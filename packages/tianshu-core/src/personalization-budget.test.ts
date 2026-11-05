/**
 * 记忆注入预算治理（P6，批9 2026-11-05）纯函数单测：
 * - per-user option key 单源（personalizationUserKey/memoryProfileKeyFor）
 * - personalizationBudgetTokens（比例预算 + 下限 + 无窗口不裁剪）
 * - trimProfileToBudget（段优先级裁剪序：近期动态 → 当前关注 → 个人背景 →
 *   工作背景；预算内逐字节不变；逐行从节尾丢弃）
 * - trimPersonalizationForBudget（persona/memory/customInstructions 先占预算，
 *   画像只用余量；优先序 customInstructions > memory > 背景 > 当前关注 > 近期动态）
 */
import { describe, expect, it } from "vitest";

import {
  MEMORY_BUDGET_MIN_TOKENS,
  MEMORY_BUDGET_RATIO,
  personalizationBudgetTokens,
  trimPersonalizationForBudget,
  trimProfileToBudget,
} from "./personalization-budget";
import {
  PERSONALIZATION_USER_FIELDS,
  defaultPersonalization,
  memoryLastCompiledAtKeyFor,
  memoryLastErrorKeyFor,
  memoryProfileKeyFor,
  personalizationUserKey,
} from "./personalization-config";

describe("per-user option key 单源（P2.1）", () => {
  it("personalizationUserKey 拼 personalization.<userId>.<field>", () => {
    expect(personalizationUserKey(5, "memoryProfile")).toBe(
      "personalization.5.memoryProfile",
    );
  });
  it("memoryProfileKeyFor / LastCompiledAt / LastError 三键", () => {
    expect(memoryProfileKeyFor(12)).toBe("personalization.12.memoryProfile");
    expect(memoryLastCompiledAtKeyFor(12)).toBe(
      "personalization.12.memoryLastCompiledAt",
    );
    expect(memoryLastErrorKeyFor(12)).toBe(
      "personalization.12.memoryLastError",
    );
  });
  it("PERSONALIZATION_USER_FIELDS 恰为三字段（迁移/读取/前端解析共用面）", () => {
    expect([...PERSONALIZATION_USER_FIELDS]).toEqual([
      "memoryProfile",
      "memoryLastCompiledAt",
      "memoryLastError",
    ]);
  });
});

describe("personalizationBudgetTokens", () => {
  it("大窗口按比例取预算", () => {
    expect(personalizationBudgetTokens(131072)).toBe(
      Math.floor(131072 * MEMORY_BUDGET_RATIO),
    );
  });
  it("小窗口保底 MEMORY_BUDGET_MIN_TOKENS", () => {
    expect(personalizationBudgetTokens(8192)).toBe(MEMORY_BUDGET_MIN_TOKENS);
    expect(personalizationBudgetTokens(4096)).toBe(MEMORY_BUDGET_MIN_TOKENS);
  });
  it("无窗口（null/undefined/0）→ Infinity（不裁剪，行为与批前一致）", () => {
    expect(personalizationBudgetTokens(null)).toBe(Number.POSITIVE_INFINITY);
    expect(personalizationBudgetTokens(undefined)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(personalizationBudgetTokens(0)).toBe(Number.POSITIVE_INFINITY);
  });
});

/** 四节画像（每条一行，节内多行便于裁剪断言） */
const PROFILE = [
  "## 工作背景",
  "[2026-10-01] - 后端用 NestJS",
  "[2026-10-02] - 桌面用 Electron",
  "",
  "## 个人背景",
  "[2026-10-03] - 在厦门",
  "",
  "## 当前关注",
  "[2026-10-04] - 记忆系统",
  "",
  "## 近期动态",
  "[2026-10-05] - 发布 v1",
  "[2026-10-06] - 发布 v2",
].join("\n");

describe("trimProfileToBudget", () => {
  it("预算内 → 原样返回（逐字节稳定，前缀缓存友好）", () => {
    expect(trimProfileToBudget(PROFILE, 10_000)).toBe(PROFILE);
    expect(trimProfileToBudget("", 100)).toBe("");
  });
  it("超预算 → 先丢近期动态节尾行（最低优先级），其余节不动", () => {
    // 1 token ≈ 2 字符：给足预算只容丢 1~2 行的程度
    const budget = Math.ceil(PROFILE.length / 2) - 8;
    const trimmed = trimProfileToBudget(PROFILE, budget);
    expect(trimmed).toContain("[2026-10-05] - 发布 v1");
    expect(trimmed).not.toContain("发布 v2");
    expect(trimmed).toContain("## 近期动态");
    expect(trimmed).toContain("[2026-10-04] - 记忆系统");
    expect(trimmed).toContain("[2026-10-01] - 后端用 NestJS");
  });
  it("持续收紧 → 依序丢近期动态 → 当前关注 → 个人背景（工作背景最后）", () => {
    // 只容工作背景一行的紧预算：追加序语义下丢节头最旧（10-01），留 10-02
    const keep = "## 工作背景\n[2026-10-02] - 桌面用 Electron";
    const trimmed = trimProfileToBudget(
      PROFILE,
      Math.ceil(keep.length / 2) + 4,
    );
    expect(trimmed).toContain("[2026-10-02] - 桌面用 Electron");
    expect(trimmed).not.toContain("[2026-10-01] - 后端用 NestJS");
    expect(trimmed).not.toContain("## 近期动态");
    expect(trimmed).not.toContain("## 当前关注");
    expect(trimmed).not.toContain("## 个人背景");
  });
  it("预算极小 → 空串（不产生无内容标题壳）", () => {
    expect(trimProfileToBudget(PROFILE, 1)).toBe("");
  });
  it("节内清空后标题行一并移除（不留空节标题）", () => {
    const trimmed = trimProfileToBudget(
      PROFILE,
      Math.ceil(PROFILE.length / 2) - 20,
    );
    if (!trimmed.includes("发布 v1")) {
      // 近期动态整节被清的场景下不残留孤立标题
      expect(trimmed).not.toMatch(/^## 近期动态$/m);
    }
  });
  it("无标题画像（全量进工作背景语义）从尾部裁剪", () => {
    const noHeading = ["a".repeat(10), "b".repeat(10), "c".repeat(10)].join(
      "\n",
    );
    const trimmed = trimProfileToBudget(noHeading, 8);
    expect(trimmed).toBe("c".repeat(10));
  });
});

describe("trimPersonalizationForBudget", () => {
  it("无窗口 → 原配置对象返回（不裁剪）", () => {
    const config = { ...defaultPersonalization(), memoryProfile: PROFILE };
    expect(trimPersonalizationForBudget(config, null)).toBe(config);
    expect(trimPersonalizationForBudget(config, undefined)).toBe(config);
  });
  it("persona/memory/customInstructions 先占预算，画像只用余量", () => {
    // 窗口 40000 → 预算 floor(40000*0.12)=4800；固定段 1000+500+300=1800
    // → 画像余量 3000 token（≈6000 字符）；画像 200 行×51 字 ≈ 10200 字符
    // 必须裁剪且裁到余量内
    const bigProfile = [
      "## 工作背景",
      ...Array.from({ length: 200 }, (_, i) =>
        `[2026-01-01] - 条目${i}x`.repeat(3),
      ),
    ].join("\n");
    const config = {
      ...defaultPersonalization(),
      persona: "人".repeat(2000), // 1000 token
      memory: "手".repeat(1000), // 500 token
      customInstructions: "规".repeat(600), // 300 token
      memoryProfile: bigProfile,
    };
    const trimmed = trimPersonalizationForBudget(config, 40000);
    expect(trimmed).not.toBe(config);
    expect(trimmed.memoryProfile.length).toBeGreaterThan(0);
    expect(trimmed.memoryProfile.length).toBeLessThanOrEqual(6000 + 2);
    // 高优先段原样保留
    expect(trimmed.persona).toBe(config.persona);
    expect(trimmed.memory).toBe(config.memory);
    expect(trimmed.customInstructions).toBe(config.customInstructions);
  });
  it("固定段本身超预算 → 画像清空，其余段不裁（优先序：指令/手动记忆高于画像）", () => {
    // 窗口 8192 → 预算保底 2048；persona 4200 字=2100 token 已超 → 余量负
    const config = {
      ...defaultPersonalization(),
      persona: "人".repeat(4200),
      memoryProfile: PROFILE,
    };
    const trimmed = trimPersonalizationForBudget(config, 8192);
    expect(trimmed.memoryProfile).toBe("");
    expect(trimmed.persona).toBe(config.persona);
  });
  it("画像裁剪后无变化 → 返回原对象（引用稳定，缓存友好）", () => {
    const config = { ...defaultPersonalization(), memoryProfile: "短画像" };
    expect(trimPersonalizationForBudget(config, 100_000)).toBe(config);
  });
});
