import { RaUser } from '../../generated/prisma';

/** relay-admin 用户响应 DTO：对外只透出管理面字段——审计字段
 * （creator/updator）与库内 id 列名经 userId 显式化，不裸返库行 */
export class RaUserDto {
  userId: string;
  tenantId: string;
  name: string;
  plan: string;
  status: string;
  createdAt: Date;

  static create(row: RaUser): RaUserDto {
    const dto = new RaUserDto();
    dto.userId = row.id;
    dto.tenantId = row.tenantId;
    dto.name = row.name;
    dto.plan = row.plan;
    dto.status = row.status;
    dto.createdAt = row.createdAt;
    return dto;
  }
}
