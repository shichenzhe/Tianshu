/**
 * 场景提示段（新建任务 spec §4.2）：session.scenario 非空且已知时
 * 追加到 system 末尾；文案给模型看，不进前端 i18n
 */
const SCENARIO_PROMPTS: Record<string, string> = {
  daily:
    "当前处于日常办公场景，请侧重文档撰写、信息整理、邮件与日程等办公任务的完成质量与格式规范。",
  coding:
    "当前处于代码开发场景，请给出可直接运行的代码、准确的命令与技术解释，遵循工程最佳实践。",
  design:
    "当前处于设计创意场景，请侧重创意的多样性与表达力，给出具体的文案或提示词产出。",
};

export function buildScenarioSystem(
  scenario: string | null | undefined,
  base: string | undefined,
): string | undefined {
  const section = scenario ? SCENARIO_PROMPTS[scenario] : undefined;
  if (!section) {
    return base;
  }
  return base ? `${base}\n\n${section}` : section;
}
