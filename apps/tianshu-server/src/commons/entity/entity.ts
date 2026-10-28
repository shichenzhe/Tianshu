/**
 * 基础实体对象
 */
export class Entity {
  /** 数据标识*/
  id: string;

  constructor(partial: Partial<any>) {
    Object.assign(this, partial);
  }
}
