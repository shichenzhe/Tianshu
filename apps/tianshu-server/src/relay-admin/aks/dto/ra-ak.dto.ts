import { RaAccessKey } from '../../generated/prisma';

/** relay-admin AK 响应 DTO：管理面字段白名单——secretHash 永不透出（明文
 * 更是仅签发/轮换响应返回一次，GitHub PAT 惯例） */
export class RaAkDto {
  akId: string;
  userId: string;
  role: string;
  status: string;
  expireAt: Date;
  createdAt: Date;

  static create(row: RaAccessKey): RaAkDto {
    const dto = new RaAkDto();
    dto.akId = row.id;
    dto.userId = row.userId;
    dto.role = row.role;
    dto.status = row.status;
    dto.expireAt = row.expireAt;
    dto.createdAt = row.createdAt;
    return dto;
  }
}
