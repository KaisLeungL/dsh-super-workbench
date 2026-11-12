/**
 * Proxy configuration: the three modes, the system proxy probe, and how the two
 * combine.
 *
 * Every case drives the real resolver. The command runner and the clock are
 * injected, so a case reads a fixed registry or `scutil` transcript and never
 * spawns a process or waits for a real cache to expire — which is also what
 * keeps the assertions about THIS machine out of the suite.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectSystemProxy,
  normalizeProxyUrl,
  parseMacSystemProxy,
  parseWindowsSystemProxy,
  resetSystemProxyCache,
  resolveProxyConfiguration,
  SYSTEM_PROXY_CACHE_TTL_MS,
  systemProxyCommand,
} from '../../../src/modules/github/host/proxy.ts'

afterEach(() => { resetSystemProxyCache() })

/** `reg query` output for the Internet Settings key, as Windows prints it. */
function registryOutput(proxyEnable: string, proxyServer?: string): string {
  const lines = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '    ProxyEnable    REG_DWORD    ' + proxyEnable,
  ]
  if (proxyServer !== undefined) lines.push('    ProxyServer    REG_SZ    ' + proxyServer)
  return lines.join('\r\n') + '\r\n'
}

/** `scutil --proxy` output, as macOS prints it. */
const SCUTIL_HTTPS = [
  '<dictionary> {',
  '  ExceptionsList : <array> {',
  '    0 : *.local',
  '  }',
  '  HTTPEnable : 0',
  '  HTTPSEnable : 1',
  '  HTTPSPort : 7890',
  '  HTTPSProxy : 127.0.0.1',
  '}',
].join('\n')

describe('proxy configuration resolution', () => {
  it('operator on auto whose machine runs a system proxy reaches GitHub through it', () => {
    // Given: no proxy variable at all, and a detected system proxy
    // When: an https destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'auto',
      env: {},
      detect: () => '127.0.0.1:7890',
    })

    // Then: the system proxy is used, and the value is normalized into a URL
    expect(resolved).toEqual({ url: 'http://127.0.0.1:7890', source: 'system' })
  })

  it('operator on auto with a proxy variable keeps it over the system proxy', () => {
    // Given: both an environment proxy and a detected system proxy
    // When: a destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'auto',
      env: { HTTPS_PROXY: 'http://10.0.0.1:3128' },
      detect: () => '127.0.0.1:7890',
    })

    // Then: the environment wins, because it is the more specific statement
    expect(resolved).toEqual({ url: 'http://10.0.0.1:3128', source: 'env' })
  })

  it('operator on auto with nothing configured goes direct', () => {
    // Given: no variable and no detected system proxy
    // When: a destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'auto',
      env: {},
      detect: () => undefined,
    })

    // Then: the request goes direct
    expect(resolved).toEqual({})
  })

  it('operator on direct is not proxied even when everything else names one', () => {
    // Given: a proxy in the environment and a system proxy behind it
    // When: the direct mode resolves a destination
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'direct',
      env: { HTTPS_PROXY: 'http://10.0.0.1:3128' },
      detect: () => '127.0.0.1:7890',
    })

    // Then: neither is used
    expect(resolved).toEqual({})
  })

  it('operator on custom is proxied through the URL they typed even against the environment', () => {
    // Given: a custom proxy and a different one in the environment
    // When: a destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'custom',
      customUrl: 'http://127.0.0.1:7890',
      env: { HTTPS_PROXY: 'http://10.0.0.1:3128' },
      detect: () => '10.0.0.2:8080',
    })

    // Then: the custom URL is the decision
    expect(resolved).toEqual({ url: 'http://127.0.0.1:7890', source: 'custom' })
  })

  it('operator who typed a custom address without a scheme gets the http one', () => {
    // Given: a custom value copied out of a proxy tool, without a scheme
    // When: a destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'custom',
      customUrl: ' 127.0.0.1:7890 ',
      env: {},
      detect: () => undefined,
    })

    // Then: the scheme is added rather than the value being refused
    expect(resolved).toEqual({ url: 'http://127.0.0.1:7890', source: 'custom' })
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('https://proxy.internal:8443')).toBe('https://proxy.internal:8443')
  })

  it('operator who selected custom but typed nothing falls back to auto', () => {
    // Given: the custom mode with an empty URL, and a system proxy
    // When: a destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'custom',
      customUrl: '   ',
      env: {},
      detect: () => '127.0.0.1:7890',
    })

    // Then: an empty custom URL is not a decision, so auto decides
    expect(resolved).toEqual({ url: 'http://127.0.0.1:7890', source: 'system' })
  })

  it('operator naming a socks proxy gets a direct request and is told why', () => {
    // Given: a custom URL this transport cannot speak
    // When: a destination is resolved
    const resolved = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'custom',
      customUrl: 'socks5://127.0.0.1:1080',
      env: {},
      detect: () => undefined,
    })

    // Then: no proxy is dialled, no exception escapes, and the reason names the
    // scheme that is unsupported
    expect(resolved.url).toBeUndefined()
    expect(resolved.reason).toContain('socks5')
    expect(resolved.reason).toContain('http and https')
  })

  it('operator whose NO_PROXY covers the destination bypasses even a custom proxy', () => {
    // Given: a custom proxy and a bypass list naming the destination
    // When: the covered and an unrelated destination are resolved
    const env = { NO_PROXY: '.github.com' }
    const covered = resolveProxyConfiguration('https://api.github.com/user', {
      mode: 'custom',
      customUrl: 'http://127.0.0.1:7890',
      env,
      detect: () => undefined,
    })
    const other = resolveProxyConfiguration('https://example.com/user', {
      mode: 'custom',
      customUrl: 'http://127.0.0.1:7890',
      env,
      detect: () => undefined,
    })

    // Then: the bypass list applies to the custom source too
    expect(covered).toEqual({})
    expect(other).toEqual({ url: 'http://127.0.0.1:7890', source: 'custom' })
  })

  it('operator whose destination is not http or https is never proxied', () => {
    // Given: a custom proxy
    // When: a non-http destination is resolved
    // Then: nothing is routed anywhere
    expect(resolveProxyConfiguration('git+ssh://github.com/x/y.git', {
      mode: 'custom',
      customUrl: 'http://127.0.0.1:7890',
      env: {},
      detect: () => undefined,
    })).toEqual({})
  })
})

describe('system proxy detection', () => {
  it('operator whose Windows registry enables one proxy gets it', () => {
    // Given: a registry transcript with a single server
    // When: it is parsed
    // Then: that server is the proxy
    expect(parseWindowsSystemProxy(registryOutput('0x1', '127.0.0.1:7890'))).toBe('127.0.0.1:7890')
    expect(parseWindowsSystemProxy(registryOutput('1', 'http://127.0.0.1:7890'))).toBe('http://127.0.0.1:7890')
  })

  it('operator whose Windows proxy is a per-protocol list gets the https entry', () => {
    // Given: a transcript listing four protocols
    // When: it is parsed
    // Then: the https entry wins, because the GitHub API is https
    expect(parseWindowsSystemProxy(registryOutput('0x1', 'ftp=127.0.0.1:21;http=127.0.0.1:8080;https=127.0.0.1:8443;socks=127.0.0.1:1080')))
      .toBe('127.0.0.1:8443')
  })

  it('operator whose Windows proxy is socks-only is reported as such, to be refused above', () => {
    // Given: a transcript whose only usable entry is socks
    // When: it is parsed
    // Then: it is reported with the socks scheme, so the resolver can name the
    // unsupported scheme instead of silently going direct
    expect(parseWindowsSystemProxy(registryOutput('0x1', 'socks=127.0.0.1:1080'))).toBe('socks5://127.0.0.1:1080')
  })

  it('operator whose Windows proxy is switched off detects none', () => {
    // Given: transcripts with the switch off and with no server value
    // When: they are parsed
    // Then: both detect nothing
    expect(parseWindowsSystemProxy(registryOutput('0x0', '127.0.0.1:7890'))).toBeUndefined()
    expect(parseWindowsSystemProxy(registryOutput('0x1'))).toBeUndefined()
    expect(parseWindowsSystemProxy('')).toBeUndefined()
  })

  it('operator whose macOS scutil output enables the https proxy gets it', () => {
    // Given: a scutil transcript with only https enabled
    // When: it is parsed
    // Then: host and port are combined into a URL
    expect(parseMacSystemProxy(SCUTIL_HTTPS)).toBe('127.0.0.1:7890')
    expect(parseMacSystemProxy(SCUTIL_HTTPS.replace('HTTPSEnable : 1', 'HTTPSEnable : 0'))).toBeUndefined()
    expect(parseMacSystemProxy('')).toBeUndefined()
  })

  it('operator on a platform with no system proxy source detects none', () => {
    // Given: the linux platform
    // When: the probe command and the detection are asked for
    // Then: there is nothing to run and nothing is detected, without spawning
    expect(systemProxyCommand('linux')).toBeUndefined()
    expect(detectSystemProxy({ platform: 'linux' })).toBeUndefined()
  })

  it('operator gets one detection per cache lifetime, not one per request', () => {
    // Given: a clock and a runner that count the probes
    let clock = 1_000
    let probes = 0
    const run = (): string => { probes += 1; return registryOutput('0x1', '127.0.0.1:7890') }
    const options = { platform: 'win32' as const, run, now: () => clock }

    // When: detection is asked for three times across the lifetime boundary
    const first = detectSystemProxy(options)
    clock += SYSTEM_PROXY_CACHE_TTL_MS - 1
    const second = detectSystemProxy(options)
    clock += 2
    const third = detectSystemProxy(options)

    // Then: the cached value is reused inside the lifetime, and only the third
    // call probes again
    expect([first, second, third]).toEqual(['127.0.0.1:7890', '127.0.0.1:7890', '127.0.0.1:7890'])
    expect(probes).toBe(2)
  })

  it('operator whose probe command fails is treated as having no system proxy', () => {
    // Given: a runner that throws the way a missing registry key does
    let probes = 0
    const failing = (): string => { probes += 1; throw new Error('reg: the system cannot find the file specified') }
    let outcome: string | undefined

    // When: detection runs
    expect(() => { outcome = detectSystemProxy({ platform: 'win32', run: failing, now: () => 1_000 }) }).not.toThrow()

    // Then: the probe really ran, and the failure reads as "none" instead of
    // escaping into the request path
    expect(probes).toBe(1)
    expect(outcome).toBeUndefined()
  })
})
