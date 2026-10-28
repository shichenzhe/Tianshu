// 危险命令分级表单测（自 mirror tests/security/command-risk.test.ts 移植，
// 权限放宽 spec §4.1/§7）：正则正反例 + 复合命令分段 + CRITICAL 先于 HIGH
import { assessCommandRisk } from '../../src/core/security/command-risk';

describe('assessCommandRisk CRITICAL', () => {
  it.each([
    'rm -rf /',
    'rm -rf /etc',
    'rm -fr ~/*',
    'dd if=x of=/dev/sda',
    'mkfs.ext4 /dev/sda',
    'echo x > /etc/hosts',
    'crontab -r',
    'userdel root',
    "echo 'DROP DATABASE prod'",
    'FLUSHALL',
    'terraform destroy',
    'aws s3 delete bucket',
    'git reset --hard',
    'git clean -fdx',
    'git stash clear',
    'git push -f origin main',
    'git push origin --delete master',
    'git branch -D main',
  ])('%s → critical', (cmd) => {
    expect(assessCommandRisk(cmd)).toBe('critical');
  });
});

describe('assessCommandRisk HIGH', () => {
  it.each([
    'sudo npm install',
    'chmod 777 /tmp',
    'rm -rf /tmp/cache', // 非系统目录：HIGH 而非 CRITICAL（spec §7 反例）
    'rm -r src',
    'shred secret.txt',
    'git push -f origin feature-x', // 非主干强推：HIGH
    'git branch -D feature-x',
    'git checkout -- src/index.ts',
    'git restore .',
    'kubectl delete pod api',
    'find . -delete',
    'ls | xargs rm',
    'git push origin :feature-x',
  ])('%s → high', (cmd) => {
    expect(assessCommandRisk(cmd)).toBe('high');
  });
});

describe('assessCommandRisk 放行', () => {
  it.each([
    'ls -la',
    'rm temp.txt', // 单文件 rm 放行（rm 已移出黑名单，spec §4.3）
    'node server.js',
    'npm install',
    'git push origin main', // 普通推送
    'git status',
    'curl https://example.com', // 移出 cmdAsk 后放行
    '',
  ])('%s → null', (cmd) => {
    expect(assessCommandRisk(cmd)).toBeNull();
  });
});

describe('复合命令分段', () => {
  it.each([
    ['echo x && rm -rf /', 'critical'],
    ['ls; sudo reboot', 'high'],
    ['cat a || git reset --hard', 'critical'],
    ['echo a | grep rm -rf', 'high'], // 管道后段 grep 的参数误报 HIGH——粗分已知边界（spec §6），偏安全侧：误报仅多一次审批
  ])('%s → %s', (cmd, expected) => {
    expect(assessCommandRisk(cmd)).toBe(expected);
  });
});

describe('大小写不敏感（终审 Critical 2026-10-24：RM -RF/Sudo 穿透）', () => {
  it.each([
    ['RM -RF /', 'critical'],
    ['Sudo npm install', 'high'],
    ['GIT RESET --HARD', 'critical'],
    ['Echo Hi && RM -Rf /tmp/x', 'high'],
  ])('%s → %s', (cmd, expected) => {
    expect(assessCommandRisk(cmd)).toBe(expected);
  });
});

describe('sudo/su 去锚定 + 换行分段（终审 Important 2026-10-24）', () => {
  it.each([
    ['echo hi\nsudo npm install', 'high'], // 换行续段：原 ^\s*sudo 锚定漏判
    ['env sudo x', 'high'], // 前缀包裹：原行首锚定漏判
    ['nice -n 1 sudo reboot', 'high'],
  ])('%s → %s', (cmd, expected) => {
    expect(assessCommandRisk(cmd)).toBe(expected);
  });
});
