import { ApiProperty } from '@nestjs/swagger';
import type {
  PermissionFullGrantItem,
  PermissionFullGrantsResult,
  PermissionRememberedItem,
} from '@tianshu/protocol';

/**
 * 审批记忆行 wire 响应DTO（SDK 响应面批）：wire 形状 = 协议包
 * PermissionRememberedItem（class implements 编译期绑定）。字段以
 * permission.service.listRemembered 实际返回为准（createdAt 为 ISO 串）。
 */
export class PermissionRememberedWireDto implements PermissionRememberedItem {
  @ApiProperty({ description: '记忆行标识' })
  id: number;

  @ApiProperty({ description: '空间名（join 缺行回落 #workspaceId）' })
  workspaceName: string;

  @ApiProperty({ description: '工具名' })
  toolName: string;

  @ApiProperty({ description: '记住时间（ISO）' })
  createdAt: string;
}

/** 完全授权行（会话级运行态——{sessionId, title} 最小公共形状） */
export class PermissionFullGrantWireDto implements PermissionFullGrantItem {
  @ApiProperty({ description: '会话标识' })
  sessionId: number;

  @ApiProperty({ description: '会话标题（缺行回落「会话 #id」）' })
  title: string;
}

/** permission/listFullGrants 返回信封 */
export class PermissionFullGrantsWireDto implements PermissionFullGrantsResult {
  @ApiProperty({
    description: '完全授权会话列表（运行态）',
    type: [PermissionFullGrantWireDto],
  })
  grants: PermissionFullGrantWireDto[];
}
