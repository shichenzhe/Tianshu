import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PLACEHOLDERS, applyPlaceholders } from '../../scripts/lib/replace.js';

describe('replace 引擎', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shu-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 占位符字面量用拼接构造，避免 init 扫描到测试源码自身
  const PH = (key: string) => `{{${key}}}`;

  it('PLACEHOLDERS 恰好包含四个占位符键', () => {
    expect([...PLACEHOLDERS]).toEqual([
      'APP_NAME',
      'JWT_SECRET',
      'AUTHOR',
      'REPO_URL',
    ]);
  });

  it('替换占位符并返回被修改的文件', async () => {
    await mkdir(join(dir, 'src'));
    await writeFile(
      join(dir, 'src', 'config.yml'),
      `name: '${PH('APP_NAME')}'`,
    );
    await writeFile(join(dir, 'README.md'), `author: ${PH('AUTHOR')}`);

    const changed = await applyPlaceholders(dir, {
      APP_NAME: 'my-service',
      JWT_SECRET: 'abc',
      AUTHOR: 'someone',
      REPO_URL: '',
    });

    expect(changed.length).toBe(2);
    expect(await readFile(join(dir, 'src', 'config.yml'), 'utf8')).toBe(
      `name: 'my-service'`,
    );
  });

  it('幂等：再次 init 时旧值也被替换', async () => {
    const file = join(dir, 'app.md');
    await writeFile(file, `title: ${PH('APP_NAME')}`);

    await applyPlaceholders(dir, {
      APP_NAME: 'first',
      JWT_SECRET: '',
      AUTHOR: '',
      REPO_URL: '',
    });
    const changed = await applyPlaceholders(dir, {
      APP_NAME: 'second',
      JWT_SECRET: '',
      AUTHOR: '',
      REPO_URL: '',
    });

    expect(await readFile(file, 'utf8')).toBe('title: second');
    expect(changed).toContain(file);
  });

  it('将配置写入 shu-init.json', async () => {
    await applyPlaceholders(dir, {
      APP_NAME: 'x',
      JWT_SECRET: 'y',
      AUTHOR: '',
      REPO_URL: '',
    });
    const saved = JSON.parse(
      await readFile(join(dir, 'shu-init.json'), 'utf8'),
    );
    expect(saved.APP_NAME).toBe('x');
  });
});
