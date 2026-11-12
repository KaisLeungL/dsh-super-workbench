import { readFileSync } from 'node:fs';

export const QUICK_ACTIONS_SKILL = 'dsh-quick-actions';
export const LOAD_QUICK_ACTIONS_SKILL = 'steward_load_quick_actions_skill';
const packageRoot = new URL(import.meta.url).pathname.endsWith('/skill.ts') ? '../../' : '../';
const skillFile = new URL(packageRoot + 'skills/dsh-quick-actions/SKILL.md', import.meta.url);
const markdown = readFileSync(skillFile, 'utf8');
export const quickActionsSkill = {
  name: QUICK_ACTIONS_SKILL,
  description: '为定时任务或看板任务准备可编辑的 DSH 快捷操作卡片。',
  source: 'bundled',
  invocation: { modelInvocable: true, userInvocable: false },
  content: markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim(),
};
