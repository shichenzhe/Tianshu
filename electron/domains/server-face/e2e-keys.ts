// relay E2E 静态身份密钥持久化（spec 2026-10-18-relay-e2e §2.1/§3.2，E2E-T2）：
// option 表独立行 type="app" name="serverFace.e2eKey"（与 serverFace 配置行
// 分离——密钥轮换不动配置，配置读写不触密钥），serializeStaticPair 单串形态
// 存取（@tianshu/core e2e-crypto，跨仓单份 wire 契约）。
// 惰性生成：首个需要方（握手处理 / 设置面 status 显示）触发生成并落库；
// 存储损坏（畸形前缀/长度/公私不匹配）自愈重生成——指纹随更，控制端
// expectedFingerprint 校验不匹配断开，属显式密钥轮换语义。
import prisma from "../../commons/prisma-client";
import Log from "../../commons/Log";
import {
  generateStaticPair,
  parseStaticPair,
  serializeStaticPair,
  type E2EKeyPair,
} from "@tianshu/core";

const OPTION_TYPE = "app";
const OPTION_NAME = "serverFace.e2eKey";

function findKeyRowId(): Promise<number | null> {
  return prisma.option
    .findFirst({
      where: { type: OPTION_TYPE, name: OPTION_NAME },
      select: { id: true },
    })
    .then((row) => row?.id ?? null);
}

/** 只读当前静态对；未生成/损坏返回 null（损坏记日志——自愈在 ensure 侧） */
export async function readE2eStaticPair(): Promise<E2EKeyPair | null> {
  const row = await prisma.option.findFirst({
    where: { type: OPTION_TYPE, name: OPTION_NAME },
  });
  if (!row) return null;
  try {
    return parseStaticPair(row.value);
  } catch (e) {
    Log.warn("serverFace e2eKey 存储损坏，将重生成（指纹随更）", e);
    return null;
  }
}

/** 确保静态对存在（缺失/损坏即生成并持久化）。option 行与 serverFace 配置
 * 同法持久化：findFirst 定位 + update/create（type="app" 行 userId 恒 NULL） */
export async function ensureE2eStaticPair(): Promise<E2EKeyPair> {
  const existing = await readE2eStaticPair();
  if (existing) return existing;
  const pair = generateStaticPair();
  const value = serializeStaticPair(pair);
  const rowId = await findKeyRowId();
  if (rowId) {
    await prisma.option.update({ where: { id: rowId }, data: { value } });
  } else {
    await prisma.option.create({
      data: { type: OPTION_TYPE, name: OPTION_NAME, value },
    });
  }
  Log.info("serverFace e2e 静态密钥已生成并持久化");
  return pair;
}
