import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const bundlePath = join('lib', 'client.js')

const bundleExists = existsSync(bundlePath)

describe('client bundle (lib/client.js)', () => {
  // The bundle is a build artifact; tests run from source in fresh checkouts.
  it.skipIf(!bundleExists)('registers through the ModuleLoader facade and its factory evaluates to a cordis plugin', () => {
    // Mirror ClientModuleLoader.register/materialize exactly: the loader
    // invokes factory(require) with ONE argument and takes the return value
    // as the module's exports (packages/client/modules). A factory that
    // expects loader-injected module/exports crashes on the real host.
    const registered: { id: string; factory: (require: (id: string) => unknown) => unknown }[] = []
    const sandbox: Record<string, unknown> = {
      window: {
        __ModuleLoader__: {
          load: (row: (typeof registered)[number]) => { registered.push(row) },
        },
      },
      console,
    }
    vm.createContext(sandbox)
    vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox, { filename: 'client.js' })

    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe('dsh-repo-board')
    expect(typeof registered[0]!.factory).toBe('function')

    // Evaluate the factory with stubbed externals (the host module table).
    const jsx = { jsx: () => null, jsxs: () => null, Fragment: 'react-fragment' }
    const externals: Record<string, unknown> = {
      react: { createElement: () => null, Fragment: 'react-fragment' },
      'react/jsx-runtime': jsx,
      'react-dom': {},
      '@deepseek-ai/cordis': {},
    }
    // The real loader's single-argument call - no injected module/exports.
    const plugin = registered[0]!.factory(
      (id: string) => {
        if (id in externals) return externals[id]!
        throw new Error('unexpected external: ' + id)
      },
    )

    // The factory's return value IS the module's exports surface.
    expect(plugin).toBeTypeOf('object')
    const surface = plugin as Record<string, unknown>
    expect(surface['apply']).toBeTypeOf('function')
    expect(surface['inject']).toEqual(['slots', 'sidebarRightTabs', 'sidebarRight'])
    expect(surface['BOARD_ADDRESS']).toBe('dsh-resource://repo-board/graph')
  })

  it.skipIf(bundleExists)('skips when the bundle has not been built', () => {
    expect(true).toBe(true)
  })
})
