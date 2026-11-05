// src-react/domains/ai/provider/lib/model-type-guess.ts
/** 模型类型名称启发式（远端导入预填）：实现已收编 @tianshu/core 单源
 *  （Task 9 批 5 小项——桌面/移动双份收编），此处 re-export 保持老
 *  import 链不变。子路径消费（渲染层禁裸引 core barrel——e2e-crypto
 *  经 vite renderer 改写会炸 sandbox，guard 测试守护） */
export {
  guessModelType,
  type ModelTypeGuess,
} from "@tianshu/core/model-type";
