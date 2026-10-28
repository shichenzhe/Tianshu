/**
 * 错误码枚举
 */
export enum ErrorCodeEnum {
  /** 成功 */
  SUCCESS = '2000',
  /** 内部服务器错误 */
  INTERNAL_SERVER_ERROR = '5000',
  /** 桥请求无效/已应答（TB-T1：requestId 一次性——未知/重复/已收敛） */
  TOOL_REQUEST_INVALID = '4005',
  /** 未认证 */
  UNAUTHORIZED = '4010',
  /** 未授权 */
  FORBIDDEN = '4030',
  /** 资源不存在 */
  NOT_FOUND = '4040',
  /** 方法不允许 */
  METHOD_NOT_ALLOWED = '4050',
  /** 不支持的媒体类型 */
  UNSUPPORTED_MEDIA_TYPE = '4150',
}
