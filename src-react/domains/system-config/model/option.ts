/**
 * 选项数据接口
 */
export interface OptionItem {
  value: string;
  name: string;
  note?: string;
}

export interface OptionCreateParams {
  type: string;
  value: string;
  name: string;
  note?: string;
}

export interface OptionQueryParams {
  type: string;
}

export interface OptionDeleteParams {
  type: string;
  name: string;
}

export interface OptionUpdateParams {
  type: string;
  name: string;
  value: string;
  note?: string;
}

export interface TaskOptions {
  types: OptionItem[];
  products: OptionItem[];
  projects: OptionItem[];
}
