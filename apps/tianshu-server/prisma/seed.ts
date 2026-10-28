import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('开始初始化数据库...');

  // 创建默认管理员账号（用户名 admin / 密码 123456，生产环境请立即修改）
  const adminPasswordHash = await bcrypt.hash('123456', 10);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      passwordHash: adminPasswordHash,
      name: '系统管理员',
      userType: 'admin',
      isActive: true,
      createdAt: new Date(),
      creatorId: 'init',
      creatorName: 'init',
      updatedAt: new Date(),
      updatorId: 'init',
      updatorName: 'init',
    },
  });
  console.log('创建管理员账号:', admin.username);

  console.log('数据库初始化完成!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
