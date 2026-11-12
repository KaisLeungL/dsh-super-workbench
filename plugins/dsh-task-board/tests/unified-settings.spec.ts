import { describe, expect, it } from 'vitest'
import { bindSettingsForm as github } from '../src/modules/github/client/index.ts'
import { bindSettingsForm as team } from '../src/modules/team/client/index.ts'

describe('统一包的模块原生设置绑定', () => {
  for (const [feature, bind] of [['github', github], ['team', team]] as const) {
    it(`operator ${feature} 在家族桥不认识模块时仍绑定真实配置行`, () => {
      // Given: 原家族桥不认识内置模块，但宿主提供了真实配置行。
      // When: 模块绑定自己的原生设置表单。
      // Then: 绑定对应行并读回已关闭的开关。
      const requested: string[] = []
      const form = { getSnapshot: () => ({ value: { enabled: false } }), subscribe: () => () => {} }
      const forms = {
        get: (id: string) => { requested.push(id); return form },
        describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: `ui-task-board-${feature}` }] } }), subscribe: () => () => {} }),
      }
      const ctx = { configForms: forms, get: (name: string) => name === 'configForms' ? forms : { bind: () => { throw new Error('legacy namespace is unavailable') } } }
      const bound = bind(ctx as never)
      expect(requested).toEqual([`ui-task-board-${feature}`])
      expect(bound.getSnapshot().value?.enabled).toBe(false)
    })
  }
})
