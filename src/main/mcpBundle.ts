import { zip } from './zip'

// MCP bundle (.mcpb: a zip with manifest.json, modelcontextprotocol/mcpb):
// the stdio bridge packaged so desktop assistants with extensions install it
// in one step. It runs with the assistant's own Node.js.

export interface BundleInput {
  version: string
  /** Source of scripts/boar-mcp.mjs. */
  bridge: string
  /** mcp.json of this Boar when it is not in the usual place ('' = the usual place). */
  configPath: string
  tools: { name: string; description: string }[]
  icon?: Uint8Array
}

const REPOSITORY = 'https://github.com/MatteoFilosa/boar'

export function bundleManifest(input: Omit<BundleInput, 'bridge' | 'icon'> & { icon: boolean }): object {
  return {
    manifest_version: '0.3',
    name: 'boar',
    display_name: 'Boar',
    version: input.version,
    description: 'Edit videos in Boar, the free local video editor: cuts, fillers, captions, Shorts, effects and renders.',
    long_description:
      'Reads and edits the timeline of Boar on this computer. Boar must have Options › AI Agents turned on; ' +
      'when it is closed, the first Boar tool used opens it. Video and audio stay on this computer, except the frames the assistant asks to see.',
    author: { name: 'Matteo Filosa', url: 'https://github.com/MatteoFilosa' },
    homepage: REPOSITORY,
    repository: { type: 'git', url: REPOSITORY },
    license: 'MIT',
    ...(input.icon ? { icon: 'icon.png' } : {}),
    server: {
      type: 'node',
      entry_point: 'server/boar-mcp.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/boar-mcp.mjs'],
        ...(input.configPath ? { env: { BOAR_MCP_CONFIG: input.configPath } } : {})
      }
    },
    tools: input.tools.map((t) => ({ name: t.name, description: firstSentence(t.description) })),
    tools_generated: true,
    prompts_generated: true,
    compatibility: { platforms: ['win32', 'darwin', 'linux'], runtimes: { node: '>=18.0.0' } }
  }
}

function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/)
  return end > 0 ? text.slice(0, end + 1) : text
}

/** The .mcpb file. */
export function mcpBundle(input: BundleInput): Buffer {
  const manifest = bundleManifest({ ...input, icon: !!input.icon })
  return zip([
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'server/boar-mcp.mjs', data: input.bridge },
    ...(input.icon ? [{ name: 'icon.png', data: input.icon }] : [])
  ])
}
