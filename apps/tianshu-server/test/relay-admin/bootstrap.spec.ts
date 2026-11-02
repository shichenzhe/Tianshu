// relay-admin 独立入口 bootstrap e2e（Task 9）：管理员 JWT 鉴权 + 统一包装
// + health——对 RaAppModule（src/relay-admin/app.module.ts）整树起 Test 模块，
// 真实 RA Prisma 临时库 + 真实守卫/拦截器/过滤器链。
//
// 环境装配（fs mock + 临时库 + seed）已收编 helpers/（Task 12）——
// ra-fs-mock 必须先于一切被测导入（configuration.ts 顶层读 config.yml）。
import './helpers/ra-fs-mock';
import {
  createRaTestApp,
  destroyRaTestApp,
  RA_TEST_ADMIN_PASSWORD,
  RaTestApp,
} from './helpers/ra-test-app';

import request from 'supertest';
import { JwtAuthService } from 'src/commons/auth/jwt-auth.service';

describe('relay-admin bootstrap（Task 9：鉴权/统一包装/health）', () => {
  let ra: RaTestApp;

  beforeAll(async () => {
    ra = await createRaTestApp({ tmpPrefix: 'relay-admin-bootstrap-' });
  });

  afterAll(async () => {
    await destroyRaTestApp(ra);
  });

  it('未带 JWT 访问受保护业务路由（users 列表）→ 401', async () => {
    const response = await request(ra.server).get('/relay-admin/users');
    expect(response.status).toBe(401);
  });

  it('login 换 token 后访问 users 列表 → 200 且 {code,message,data} 统一包装', async () => {
    const login = await request(ra.server)
      .post('/relay-admin/auth/login')
      .send({ username: 'admin', password: RA_TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.code).toBe('2000');
    const accessToken: string | undefined = login.body.data?.accessToken;
    expect(typeof accessToken).toBe('string');
    expect(typeof login.body.data?.refreshToken).toBe('string');

    // Task 10 起探针由真实路由顶替：空库列表返回 data: []
    const list = await request(ra.server)
      .get('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      code: '2000',
      success: true,
      data: [],
      message: 'success',
    });
  });

  it('错误口令 login → 401（不签发 token）', async () => {
    const response = await request(ra.server)
      .post('/relay-admin/auth/login')
      .send({ username: 'admin', password: 'wrong-password' });
    expect(response.status).toBe(401);
    expect(response.body.data).toBeNull();
  });

  it('载荷 sub 非 ra_admin_user 行（幻影/跨域 token）→ users 列表 401', async () => {
    // 签名合法但 sub 不在管理员表：回查必须拒绝（操作者身份只认 ra_admin_user）
    const jwtAuthService = ra.app.get(JwtAuthService);
    const { accessToken } = jwtAuthService.generateTokens({
      sub: 'not-an-ra-admin-id',
      username: 'ghost',
      name: 'ghost',
      roles: ['ra-admin'],
    });
    const response = await request(ra.server)
      .get('/relay-admin/users')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(response.status).toBe(401);
  });

  it('/actuator/health → 200（excludePaths 直出 Terminus 体）', async () => {
    const response = await request(ra.server).get('/actuator/health');
    expect(response.status).toBe(200);
    // 直出（无统一包装）：Terminus 体顶层 status=ok（up 是各指标项语义）
    expect(response.body).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );
  });
});
