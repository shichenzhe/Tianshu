// node 测试环境的 nativewind 替身：真身入口含 RN/Flow 语法，node 环境不可
// 加载；且「实体在 app 本地树还是根 hoist」决定 rolldown 是否原样交给 Node
// 原生编译（位置敏感，node_modules 重排后行为漂移）。resolver 层 alias 钉死
// （vitest.config 的 nativewind$ 精确别名），与各测试文件内的 vi.mock 互为
// 独立防线。覆盖面 = src 实际 import 面：useColorScheme、colorScheme
const noop = () => {};

export const colorScheme = { set: noop };

export const useColorScheme = () => ({
  colorScheme: "light" as const,
  setColorScheme: noop,
});
