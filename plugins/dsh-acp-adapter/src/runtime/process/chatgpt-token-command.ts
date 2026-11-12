/// <reference types="node" />
/** Codex auth.command 协议只允许在 stdout 输出令牌。 */
import { request } from 'node:http'
const [endpoint, profile, binding] = process.argv.slice(2)
const secret = process.env.DSH_CHATGPT_BROKER_SECRET
if (!endpoint || !profile || !binding || !secret) process.exit(1)
const req = request(
  {
    socketPath: endpoint,
    path: `/token/${encodeURIComponent(profile)}/${encodeURIComponent(binding)}`,
    headers: { authorization: `Bearer ${secret}` },
    timeout: 28_000,
  },
  (response) => {
    let token = ''
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      token += chunk
      if (token.length > 65_536) req.destroy(new Error('Token response too large'))
    })
    response.on('end', () => {
      if (response.statusCode !== 200 || !token || /[\r\n]/.test(token)) {
        process.exitCode = 1
        return
      }
      process.stdout.write(token)
    })
    response.on('error', () => {
      process.exitCode = 1
    })
  },
)
req.on('timeout', () => req.destroy(new Error('Token request timed out')))
req.on('error', () => {
  process.exitCode = 1
})
req.end()
