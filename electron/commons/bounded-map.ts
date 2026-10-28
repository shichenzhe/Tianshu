// electron/commons/bounded-map.ts
/**
 * 有界 Map（插入序 FIFO 逐出）：超上限删最旧键——高频写入的内存缓存
 * （如 webhook 异步 job 结果）防无界增长。仅暴露 get/set/has/size 最小
 * 面，语义与 Map 对齐；重复 set 已有键不刷新位置（按首次插入序逐出）。
 */
export interface BoundedMap<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  has(key: K): boolean;
  readonly size: number;
}

export function createBoundedMap<K, V>(max: number): BoundedMap<K, V> {
  const map = new Map<K, V>();
  return {
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    set(key, value) {
      map.set(key, value);
      if (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}
