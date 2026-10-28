/** 场景定义与预设胶囊（新建任务 spec §5）：文案进 i18n，此处只存 key */
export type ScenarioKey = "daily" | "coding" | "design";

export const SCENARIO_KEYS: ScenarioKey[] = ["daily", "coding", "design"];

export function isScenarioKey(value: string): value is ScenarioKey {
  return (SCENARIO_KEYS as string[]).includes(value);
}

/** 场景→预设胶囊 chipKey（i18n: newTask:chips.<chipKey>.label / .prompt） */
export const SCENARIO_CHIPS: Record<ScenarioKey, string[]> = {
  daily: ["docProcess", "slides", "weeklyReport", "emailReply"],
  coding: ["pythonScript", "reactComponent", "sqlWriter", "debugHelper"],
  design: ["copywriting", "posterPrompt", "brainstorm"],
};

/** 场景下已打标已启用技能（胶囊尾部混排；无打标技能自然为空） */
export function filterScenarioSkills<
  T extends { enabled: boolean; scenarios?: string[] | null },
>(skills: T[], key: ScenarioKey): T[] {
  return skills.filter(
    (skill) => skill.enabled && (skill.scenarios ?? []).includes(key),
  );
}
