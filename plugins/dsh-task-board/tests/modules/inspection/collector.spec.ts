import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import { collectEvidence, containsSecret } from '../../../src/modules/inspection/host/collector.ts'
import type { InspectionRule } from '../../../src/modules/inspection/core/types.ts'

describe('授权项目证据采集', () => {
  let root: string
  let rule: InspectionRule
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-inspection-test-'))
    rule = { id: 'rule', workspaceId: 'w', enabled: true, root, goal: '核对目标', revision: 1, paths: ['.'], model: 'p/m', daily: false, cron: '0 9 * * *', timeZone: 'Asia/Shanghai', maxRecommendations: 3 }
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  it('operator：给定授权文档与秘密和产物目录，当采集时，只返回安全文档与覆盖统计', async () => {
    // Given: 授权文档与秘密和产物目录
    // When: 采集
    // Then: 只返回安全文档与覆盖统计
    await writeFile(join(root, 'progress.md'), '目标：完善验收。')
    await writeFile(join(root, '.env'), 'PASSWORD=private-password')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'notes.md'), 'dependency')
    await writeFile(join(root, 'credentials.json'), '{"password":"private-password"}')
    await writeFile(join(root, 'notes.md'), 'api_key = "private-value-1234"')
    const result = await collectEvidence(rule, { id: 'w', path: root })
    expect(result.evidence.map(value => value.path)).toEqual(['progress.md'])
    expect(result.coverage).toMatchObject({ files: 1, omitted: 4, truncated: false })
    expect(result.evidence[0]?.text).toBe('目标：完善验收。')
  })
  it('operator：给定越界授权路径，当采集时，拒绝读取', async () => {
    // Given: 越界授权路径
    // When: 采集
    // Then: 拒绝读取
    rule.paths = ['../outside.md']
    await expect(collectEvidence(rule, { id: 'w', path: root })).rejects.toThrow('path-outside-root')
  })
  it('operator：给定越界根目录，当采集时，拒绝扫描', async () => {
    // Given: 越界根目录
    // When: 采集
    // Then: 拒绝扫描
    await mkdir(join(root, 'nested'))
    await expect(collectEvidence(rule, { id: 'w', path: join(root, 'nested') })).rejects.toThrow('root-outside-workspace')
  })
  it('operator：给定根内或根外符号链接，当显式授权链接时，都拒绝跟随', async () => {
    // Given: 根内或根外符号链接
    // When: 显式授权链接
    // Then: 都拒绝跟随
    await writeFile(join(root, 'target.md'), 'private target')
    await symlink(join(root, 'target.md'), join(root, 'linked.md'))
    rule.paths = ['linked.md']
    await expect(collectEvidence(rule, { id: 'w', path: root })).rejects.toThrow('symlink-in-scope')
  })
  it('operator：给定嵌套链接目录，当递归扫描时，不返回链接内容', async () => {
    // Given: 嵌套链接目录
    // When: 递归扫描
    // Then: 不返回链接内容
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'docs', 'safe.md'), 'safe')
    await symlink(join(root, 'docs'), join(root, 'alias'))
    const result = await collectEvidence(rule, { id: 'w', path: root })
    expect(result.evidence.map(value => value.path)).toEqual(['docs/safe.md'])
    expect(result.coverage.omitted).toBe(1)
  })
  it('operator：给定超大文件和二进制，当采集时，跳过且不截取秘密尾部', async () => {
    // Given: 超大文件和二进制
    // When: 采集
    // Then: 跳过且不截取秘密尾部
    await writeFile(join(root, 'large.md'), 'a'.repeat(20000))
    await writeFile(join(root, 'binary.txt'), Buffer.from([0, 1, 2]))
    expect((await collectEvidence(rule, { id: 'w', path: root })).evidence).toEqual([])
  })
  it('operator：给定未授权项目或取消信号，当采集时，拒绝读取', async () => {
    // Given: 未授权项目或取消信号
    // When: 采集
    // Then: 拒绝读取
    rule.enabled = false
    await expect(collectEvidence(rule, { id: 'w', path: root })).rejects.toThrow('project-not-authorized')
    rule.enabled = true
    await expect(collectEvidence(rule, { id: 'w', path: root }, AbortSignal.abort())).rejects.toThrow()
  })
  it('operator：给定大量文档，当达到独立文件数预算时，覆盖报告明确截断', async () => {
    // Given: 大量文档
    // When: 达到独立文件数预算
    // Then: 覆盖报告明确截断
    for (let i = 0; i < 30; i++) await writeFile(join(root, 'note-' + i + '.md'), 'safe')
    const result = await collectEvidence(rule, { id: 'w', path: root })
    expect(result.evidence).toHaveLength(24)
    expect(result.coverage.truncated).toBe(true)
  })
  it('operator：给定已授权 Git 仓库，当收集提交与暂存路径时，不运行清理过滤脚本', async () => {
    // Given: 已授权 Git 仓库
    // When: 收集提交与暂存路径
    // Then: 不运行清理过滤脚本
    await exec('git', ['init', '-q'], { cwd: root })
    await exec('git', ['config', 'user.name', 'Fixture'], { cwd: root })
    await exec('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root })
    await writeFile(join(root, 'progress.md'), 'first')
    await exec('git', ['add', 'progress.md'], { cwd: root })
    await exec('git', ['commit', '-qm', 'fixture baseline'], { cwd: root })
    await writeFile(join(root, '.gitattributes'), '*.md filter=evil')
    await exec('git', ['config', 'filter.evil.clean', 'touch sentinel-executed'], { cwd: root })
    await writeFile(join(root, 'progress.md'), 'second')
    rule.includeGit = true
    const result = await collectEvidence(rule, { id: 'w', path: root })
    expect(result.coverage.git).toBe('collected')
    expect(result.evidence.find(value => value.path === 'git-summary')?.text).toContain('fixture baseline')
    const { access } = await import('node:fs/promises')
    await expect(access(join(root, 'sentinel-executed'))).rejects.toThrow()
  })
  it('operator：给定常见凭据内容，当校验时，识别私钥与 token', () => {
    // Given: 常见凭据内容
    // When: 校验
    // Then: 识别私钥与 token
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    expect(containsSecret('ghp_12345678901234567890')).toBe(true)
    expect(containsSecret('普通的项目进度和验收标准')).toBe(false)
  })
})

