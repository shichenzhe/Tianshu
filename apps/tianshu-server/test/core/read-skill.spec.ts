// 移植自 mirror tests/ai/read-skill.test.ts（path 子文件读取批）：read_skill
// 增可选 path 参数——以命中技能 dir 为锚 resolve+realpath 双重校验读包内
// 子文件（references/*.md 渐进披露），越界/读败/NUL 均转错误串回喂。
// 仅移植 path 能力面与最小基础路径（存在名/未知名/元信息）；截断阈值等
// 纯副本行为不再重复覆盖（源码逐字同构由 check:drift 守护）。
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSkills } from 'src/core/tools/skill-loader';
import type { SkillInfo } from 'src/core/tools/skill-loader';
import { makeReadSkillTool } from 'src/core/tools/read-skill';

let root: string;
let userDir: string;
let skills: SkillInfo[];

const SKILL = (name: string, description: string, body = '技能正文') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'read-skill-srv-'));
  userDir = path.join(root, 'user-skills');
  mkdirSync(userDir);
  mkdirSync(path.join(userDir, 'greeting'));
  writeFileSync(
    path.join(userDir, 'greeting', 'SKILL.md'),
    SKILL('greeting', '问候', '你好，我是问候技能'),
  );
  skills = loadSkills([{ dir: userDir, source: 'user' }]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('read_skill 元信息与基础路径', () => {
  it('name/description/kind 符合规范', () => {
    const tool = makeReadSkillTool(skills);
    expect(tool.name).toBe('read_skill');
    expect(tool.description).toBe(
      '读取技能使用指引：传技能名读 SKILL.md 正文；可传 path 读技能包内文件（如 references/jira.md）',
    );
    expect(tool.kind).toBe('read');
  });

  it('存在名返回 SKILL.md 全文（含 frontmatter）', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute({ workspacePath: root, sessionId: 1 }, { name: 'greeting' }),
    ).resolves.toBe(SKILL('greeting', '问候', '你好，我是问候技能'));
  });

  it('未知名返回错误串（无 throw）', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute({ workspacePath: root, sessionId: 1 }, { name: 'no-such' }),
    ).resolves.toBe('错误: 技能不存在');
  });
});

describe('read_skill path 子文件读取（技能包内 references 等）', () => {
  let refDir: string;

  beforeEach(() => {
    refDir = path.join(userDir, 'greeting', 'references');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(path.join(refDir, 'jira.md'), '# jira 命令详解\n');
  });

  it('传 path 返回包内子文件内容', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: 'references/jira.md' },
      ),
    ).resolves.toBe('# jira 命令详解\n');
  });

  it('path 穿越出技能目录返回越界错误', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: '../outside.md' },
      ),
    ).resolves.toBe('错误: 路径超出技能目录');
  });

  it('path 为绝对路径时拒绝', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: path.join(root, 'outside.md') },
      ),
    ).resolves.toBe('错误: 路径超出技能目录');
  });

  it('path 指向不存在文件返回读取失败', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: 'references/no-such.md' },
      ),
    ).resolves.toBe('错误: 技能文件读取失败');
  });

  it('path 指向目录返回读取失败', async () => {
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: 'references' },
      ),
    ).resolves.toBe('错误: 技能文件读取失败');
  });

  it('包内 symlink 指向包外被 realpath 二次校验拒绝', async () => {
    writeFileSync(path.join(root, 'secret.md'), '机密');
    symlinkSync(path.join(root, 'secret.md'), path.join(refDir, 'link.md'));
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: 'references/link.md' },
      ),
    ).resolves.toBe('错误: 路径超出技能目录');
  });

  it('子文件超过 256KB 按字节截断并追加尾部标记', async () => {
    writeFileSync(path.join(refDir, 'big.md'), 'a'.repeat(300 * 1024));
    const tool = makeReadSkillTool(skills);
    const out = await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: 'greeting', path: 'references/big.md' },
    );
    expect(out).toBe('a'.repeat(256 * 1024) + '\n…（已截断）');
  });

  it('子文件含 NUL 二进制内容返回不支持读取', async () => {
    writeFileSync(
      path.join(refDir, 'bin.md'),
      Buffer.from([0x61, 0x00, 0x62]),
    );
    const tool = makeReadSkillTool(skills);
    await expect(
      tool.execute(
        { workspacePath: root, sessionId: 1 },
        { name: 'greeting', path: 'references/bin.md' },
      ),
    ).resolves.toBe('错误: 文件含二进制内容（NUL），不支持读取');
  });

  it('子文件成功读取触发 onRead；越界与读败不触发', async () => {
    let fired = 0;
    const tool = makeReadSkillTool(skills, () => {
      fired++;
    });
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: 'greeting', path: 'references/jira.md' },
    );
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: 'greeting', path: '../outside.md' },
    );
    await tool.execute(
      { workspacePath: root, sessionId: 1 },
      { name: 'greeting', path: 'references/no-such.md' },
    );
    expect(fired).toBe(1);
  });
});
