/**
 * 市场搜索防抖调度器（筛选报错批②配套）：关键词输入防抖后发搜，分类
 * 切换立即发搜；keyword/category 以「最新值」语义存于实例内部——防抖
 * 定时器回调永远读最新组合。修旧 SkillHubSection 闭包 bug：定时器创建
 * 时捕获当时的 category state，切分类后旧定时器到点用旧分类发陈旧请求。
 * 纯逻辑零 RN 依赖，setTimeout 直接可经 vi.useFakeTimers 驱动测试。
 */

export class MarketSearchScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 最近一次发搜的关键词（trim 后） */
  private keyword = "";
  /** 最近一次选择的分类 */
  private category: string | null = null;

  constructor(
    private readonly onSearch: (
      keyword: string,
      category: string | null,
    ) => void,
    private readonly debounceMs: number,
  ) {}

  /** 关键词输入：防抖后发搜（到点读最新分类——不受创建时快照影响） */
  input(keyword: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.keyword = keyword.trim();
      this.onSearch(this.keyword, this.category);
    }, this.debounceMs);
  }

  /** 分类切换：立即发搜（读最新关键词，并取消未决的输入防抖定时器） */
  select(category: string | null): void {
    this.category = category;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onSearch(this.keyword, category);
  }

  /** 卸载清理：取消未决定时器 */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
