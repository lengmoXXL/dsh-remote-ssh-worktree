/**
 * The HTTP adapter for the management API.
 *
 * It owns only transport concerns: reading a bounded request body, parsing the
 * URL, and writing JSON back. Every rule about what a request may do lives in
 * {@link handleNodeApi}.
 *
 * The route is registered through `ctx.get('webServer')` rather than an
 * injected dependency, because a non-Web profile (headless, SDK) has no HTTP
 * server and the plugin must still load there.
 *
 * @module dsh-remote-worktree/web/mount
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiResponse, ManagementApiDeps } from './api.ts'
import { handleNodeApi } from './api.ts'

/** The path prefix this plugin owns. */
export const API_PREFIX = '/dsh-remote-worktree'

/** Bound on one management request body. */
const MAX_BODY_BYTES = 1 << 20

/** Read a bounded request body and parse it as JSON. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Write one normalized response. */
function writeResponse(response: ServerResponse, result: ApiResponse): void {
  const payload = JSON.stringify(result.body)
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/**
 * Register the management routes on the host's Web server.
 *
 * A missing Web server is not a failure: it means this profile serves no
 * browser, and the plugin's model-facing behavior is unaffected.
 * @param ctx - the host context.
 * @param deps - the registry and connection manager the API reads.
 */
export function registerNodeApi(ctx: Context, deps: ManagementApiDeps): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(API_PREFIX.length)
      let body: unknown
      try {
        body = await readJsonBody(request)
      } catch (error) {
        writeResponse(response, {
          status: 400,
          body: { error: error instanceof Error ? error.message : String(error) },
        })
        return
      }
      const result = await handleNodeApi({
        method: request.method ?? 'GET',
        path: path === '' ? '/' : path,
        query: url.searchParams,
        body,
      }, deps)
      writeResponse(response, result)
    },
  }))
}
