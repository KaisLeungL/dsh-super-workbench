import { readFileSync } from 'node:fs'
/**
 * Standalone build config for the task-board client plugin.
 *
 * Uses the repository's shared client-bundle preset: node-half lib/ plus the browser bundle
 * lib/client.js (closure-factory artifact for the GUI's __ModuleLoader__,
 * CSS Modules inlined with auto-injected <style data-plugin>).
 *
 * Node-half entries point at src (tsdown compiles TS directly), so the build
 * needs no separate tsc emit for runtime artifacts.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

const build = clientBundle('@linxin666/dsh-client-ui-task-board', ['src/index.ts'], {
  lib: {
    entry: {
      index: 'src/index.ts',
      inspection: 'src/modules/inspection/index.ts',
      github: 'src/modules/github/index.ts',
      team: 'src/modules/team/index.ts',
      remote: 'src/modules/remote/index.ts',
      forest: 'src/modules/forest/index.js',
    },
    copy: ['inspection', 'github', 'remote', 'team', 'forest'].map(feature => ({
      from: `src/modules/${feature}/package.json`,
      to: `lib/modules/${feature}`,
    })),
    outputOptions: {
      entryFileNames: chunk => chunk.name === 'index' ? 'index.js' : `modules/${chunk.name}/index.js`,
    },
  },
  clientPlugins: [{
    name: 'task-board-forest-assets',
    load(id) {
      if (id.includes('/modules/forest/client/assets/') && id.endsWith('.png?inline')) {
        const file = id.slice(0, -7)
        this.addWatchFile(file)
        return { code: 'export default ' + JSON.stringify('data:image/png;base64,' + readFileSync(file).toString('base64')), moduleType: 'js' }
      }
      if (!id.endsWith('/modules/forest/client/style.css?raw')) return
      const file = id.slice(0, -4)
      this.addWatchFile(file)
      return { code: 'export default ' + JSON.stringify(readFileSync(file, 'utf8')), moduleType: 'js' }
    },
  }],
  libExternal: [
    '@deepseek-ai/dsh-credentials',
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-remotes',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-store',
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-workspace',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-system-prompt',
  ],
})

/** Keep the shared build preset while selecting the suite's single browser entry. */
export default (options: Parameters<typeof build>[0]) => build(options).map(config =>
  config.name === '@linxin666/dsh-client-ui-task-board/client'
    ? { ...config, entry: { client: 'src/client/bundle.ts' } }
    : config,
)
