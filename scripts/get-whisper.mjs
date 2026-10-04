// npm run whisper: puts the speech engine (whisper.cpp) for this system into
// resources/whisper, taken from the latest successful CI build of main.
// Needs the GitHub CLI (gh), logged in. Without it, build the engine with
// scripts/build-whisper.sh (CMake, a C++ compiler and, on Windows and Linux,
// the Vulkan SDK).
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = join(root, 'resources', 'whisper')
const system = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform]
if (!system) throw new Error(`No speech engine build for ${process.platform}`)

const gh = (...args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
try {
  gh('--version')
} catch {
  console.error('The GitHub CLI (gh) is needed. Or build the engine: bash scripts/build-whisper.sh')
  process.exit(1)
}

const run = gh('run', 'list', '--workflow', 'build.yml', '--branch', 'main', '--status', 'success', '--limit', '1', '--json', 'databaseId', '--jq', '.[0].databaseId')
if (!run) throw new Error('No successful CI build of main found')
rmSync(out, { recursive: true, force: true })
console.log(`Downloading the speech engine for ${system} from CI run ${run}…`)
gh('run', 'download', run, '--name', `whisper-${system}`, '--dir', out)
const tool = join(out, process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
if (!existsSync(tool)) throw new Error('The download has no whisper-cli')
if (process.platform !== 'win32') chmodSync(tool, 0o755)
console.log(`Speech engine ready in resources/whisper (${readdirSync(out).length} files)`)
