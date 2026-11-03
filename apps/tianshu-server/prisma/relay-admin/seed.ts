import { randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { ensureRaDatabaseUrl } from '../../src/relay-admin/prisma.service';
import { PrismaClient } from '../../src/relay-admin/generated/prisma';

// 建表先行：prisma:push:ra（db push）后本脚本才可用（新库无迁移历史，
// 业界起步惯例）；env 兜底与 service 层同源（缺省 file:./data/relay-admin.db）
ensureRaDatabaseUrl();
const prisma = new PrismaClient();

async function main() {
  console.log('[ra-seed] 开始初始化 relay-admin 库...');

  const existing = await prisma.raAdminUser.count();
  if (existing > 0) {
    console.log('[ra-seed] 管理员已存在，跳过（username=admin）');
    return;
  }

  // 一次性随机口令打印到控制台（安全批 E3 同款；生产环境请立即登录修改）
  const adminPassword = randomBytes(12).toString('base64url');
  console.log(
    '[ra-seed] 初始管理员 admin 一次性口令:',
    adminPassword,
    '（请立即登录修改）',
  );
  const admin = await prisma.raAdminUser.create({
    data: {
      username: 'admin',
      passwordHash: await bcrypt.hash(adminPassword, 10),
    },
  });
  console.log('[ra-seed] 创建管理员账号:', admin.username);

  console.log('[ra-seed] relay-admin 库初始化完成!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
