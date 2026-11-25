// 작업 요약과 프로젝트 도우미의 엔진(API 키 또는 이 컴퓨터에 로그인된 CLI)과, 도우미가 읽는 코드.
// 레포마다 로컬 저장소를 하나 두고 질문할 때마다 최신으로 맞춘다.
// 데스크톱(src/main/index.ts)과 웹 서버(server.mjs)가 같이 쓴다. GitHub에는 받기만 하고, 도구는 모두 읽기 전용이다.
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'

export const REPO = /^[\w.-]+\/[\w.-]+$/

function git(dir, args, { env, signal } = {}) {
  return new Promise((ok, fail) => execFile('git', args, { cwd: dir, env, signal, maxBuffer: 64 << 20, windowsHide: true, timeout: 5 * 60_000 },
    (e, out, err) => (e ? fail(Object.assign(new Error(`git ${args[0]} 실패: ${String(err || e.message).trim().slice(0, 500)}`), { code: e.code, stderr: String(err) })) : ok(out))))
}

// 토큰은 원격 주소(.git/config)에 남기지 않고 이번 실행의 환경 변수로만 준다
const authEnv = (token) => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', ...(token && {
  GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
}) })

// 작업은 develop에 먼저 쌓이므로 develop이 있으면 develop, 없으면 기본 브랜치. 최근 커밋을 보려고 30개까지 받는다.
// 같은 레포를 동시에 맞추지 않게 진행 중인 갱신은 함께 기다린다
const syncing = new Map()
export function syncRepo(root, repo, token) {
  if (!REPO.test(repo)) throw new Error(`잘못된 레포: ${repo}`)
  const dir = join(root, ...repo.split('/'))
  if (syncing.has(dir)) return syncing.get(dir)
  const env = authEnv(token)
  const job = (async () => {
    if (!existsSync(join(dir, '.git'))) {
      mkdirSync(dir, { recursive: true })
      await git(dir, ['init', '-q'], { env })
      await git(dir, ['remote', 'add', 'origin', `https://github.com/${repo}.git`], { env })
    }
    await git(dir, ['config', 'core.longpaths', 'true'], { env }) // Windows 260자 경로 제한 (v4에 긴 경로가 있다)
    const branch = (await git(dir, ['ls-remote', '--heads', 'origin', 'develop'], { env })).trim() ? 'develop' : 'HEAD'
    await git(dir, ['fetch', '-q', '--depth', '30', 'origin', branch], { env })
    await git(dir, ['reset', '-q', '--hard', 'FETCH_HEAD'], { env }) // 도우미 전용 사본이라 덮어써도 된다
    return dir
  })().finally(() => syncing.delete(dir))
  syncing.set(dir, job)
  return job
}

// 원인 찾기 질문을 위해 최근 커밋 메시지와 바뀐 파일 (git이 아니면 빈 문자열)
export const recentCommits = (dir, n = 20) =>
  git(dir, ['log', `-${n}`, '--date=short', '--format=%n%h %ad %an  %s', '--stat=120']).then((s) => s.trim().slice(0, 8000), () => '')
export const branchOf = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((s) => s.trim(), () => '?')

// 질문 뒤에 붙이는 작업 폴더 안내. own = 사용자가 직접 고른 폴더인 레포들
export async function workspaceNote(dirs, own = []) {
  const parts = await Promise.all(Object.entries(dirs).map(async ([repo, dir]) => {
    const log = await recentCommits(dir)
    return `${repo}: ${dir}${own.includes(repo) ? ` (직접 고른 폴더, ${await branchOf(dir)})` : ''}${log && `\n[${repo} 최근 커밋]\n${log}`}`
  }))
  return `\n\n[작업 폴더 (develop이 있으면 develop 최신, 없으면 기본 브랜치 최신)]\n${parts.join('\n\n')}`
}

// ---- API 키 엔진용 읽기 전용 도구 (CLI 엔진은 자기 Read/Grep/Glob을 쓴다) ----

const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 생략, 범위를 좁혀 다시 요청)` : s)
const safeSpec = (s) => {
  if (s && (typeof s !== 'string' || s.startsWith('-') || s.includes('..'))) throw new Error(`허용되지 않은 경로: ${s}`)
  return s ? [s] : []
}
const COMMIT = /^([0-9a-f]{4,40}|HEAD(~\d{1,3})?)$/

const TOOLS = [
  { name: 'list_files', description: '레포의 파일 목록 (git ls-files). pathspec으로 폴더나 패턴(예: src/Edge, *.cs)을 좁힌다.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, pathspec: { type: 'string' } }, required: ['repo'] } },
  { name: 'grep', description: '레포에서 정규식으로 검색 (git grep -n -I -E). 결과는 "경로:줄:내용".',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, pattern: { type: 'string' }, pathspec: { type: 'string' }, ignore_case: { type: 'boolean' } }, required: ['repo', 'pattern'] } },
  { name: 'read_file', description: '파일 내용을 줄 번호와 함께 읽는다. 한 번에 최대 400줄, start/end(1부터)로 범위를 고른다.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['repo', 'path'] } },
  { name: 'git_log', description: '최근 커밋 목록과 바뀐 파일. path를 주면 그 경로를 바꾼 커밋만.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, count: { type: 'integer' } }, required: ['repo'] } },
  { name: 'git_show', description: '커밋 하나의 메시지와 diff. path를 주면 그 경로의 diff만.',
    input_schema: { type: 'object', properties: { repo: { type: 'string' }, commit: { type: 'string' }, path: { type: 'string' } }, required: ['repo', 'commit'] } },
]

export async function runTool(name, input, dirs) {
  const dir = dirs[input.repo]
  if (!dir) throw new Error(`알 수 없는 레포: ${input.repo} (가능: ${Object.keys(dirs).join(', ')})`)
  switch (name) {
    case 'list_files': return cap(await git(dir, ['ls-files', '--', ...safeSpec(input.pathspec)]), 20000) || '(없음)'
    case 'grep': {
      const out = await git(dir, ['grep', '-n', '-I', '-E', ...(input.ignore_case ? ['-i'] : []), '-e', String(input.pattern), '--', ...safeSpec(input.pathspec)])
        .catch((e) => (e.code === 1 && !e.stderr.trim() ? '' : Promise.reject(e))) // 못 찾으면 git grep은 메시지 없이 1로 끝난다
      return cap(out, 20000) || '(일치 없음)'
    }
    case 'read_file': {
      const file = resolve(dir, String(input.path))
      if (!file.startsWith(resolve(dir) + sep) || file.includes(`${sep}.git${sep}`)) throw new Error('레포 밖 경로는 읽을 수 없습니다')
      if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`파일 없음: ${input.path}`)
      const lines = readFileSync(file, 'utf8').split('\n')
      const start = Math.max(1, input.start ?? 1), end = Math.min(lines.length, input.end ?? start + 399, start + 399)
      return `${input.path} (${lines.length}줄 중 ${start}-${end})\n` + lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n')
    }
    case 'git_log': {
      const n = Math.min(Math.max(1, input.count ?? 20), 30)
      return cap(await git(dir, ['log', `-${n}`, '--date=short', '--format=%n%h %ad %an  %s', '--stat=120', '--', ...safeSpec(input.path)]), 20000) || '(없음)'
    }
    case 'git_show': {
      if (!COMMIT.test(String(input.commit))) throw new Error(`잘못된 커밋: ${input.commit}`)
      return cap(await git(dir, ['show', '--stat', '--patch', String(input.commit), '--', ...safeSpec(input.path)]), 30000)
    }
    default: throw new Error(`알 수 없는 도구: ${name}`)
  }
}

// API 키로 도구를 쓰며 답한다. dirs = { 'owner/repo': 로컬 경로 }
export async function askWithTools({ apiKey, system, text, dirs, signal }) {
  const client = new Anthropic({ apiKey })
  const messages = [{ role: 'user', content: text }]
  const tools = Object.keys(dirs).length ? TOOLS : []
  for (let turn = 0; turn < 40; turn++) {
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' }, // 도구를 부를 때마다 앞부분을 다시 보내므로 캐시
      system,
      tools,
      messages,
    }, { signal })
    if (res.stop_reason === 'refusal') throw new Error(`요청이 거절됐습니다: ${res.stop_details?.category ?? '분류 없음'}`)
    const answer = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim()
    if (res.stop_reason !== 'tool_use') return answer
    messages.push({ role: 'assistant', content: res.content })
    messages.push({ role: 'user', content: await Promise.all(res.content.filter((b) => b.type === 'tool_use').map((b) =>
      runTool(b.name, b.input ?? {}, dirs).then(
        (content) => ({ type: 'tool_result', tool_use_id: b.id, content }),
        (e) => ({ type: 'tool_result', tool_use_id: b.id, content: String(e?.message ?? e), is_error: true }))))
    })
  }
  throw new Error('코드를 너무 많이 찾아봐서 멈췄습니다. 질문을 좁혀 다시 물어보세요.')
}

// ---- 엔진 ----

export const ENGINES = ['api', 'claude', 'codex', 'antigravity']

export const SUMMARY_SYSTEM = `너는 개발팀의 작업 내용을 관리자가 읽을 기록으로 정리한다.
주어진 이슈와 커밋 정보로 무엇을 왜 바꿨는지 한국어 불릿 3~8개로 요약하라.
코드 세부보다 기능, 동작 변화, 영향 위주로 쓰고, 불릿 목록만 출력하라.`

export const ASK_SYSTEM = `너는 이 개발팀의 프로젝트 도우미다. 유지보수 질문에 한국어로 답한다.
함께 주어진 보드 정보(이슈, 에픽, 배포)를 보고, 작업 폴더의 코드를 직접 찾아 읽고 답하라.
원인을 찾는 질문이면 최근 커밋 목록에서 관련 변경을 골라 그 파일을 읽고, 의심되는 커밋과 이유를 들어라.
근거는 파일 경로:줄 번호, 커밋, 이슈 번호로 밝혀라. 파일을 고치거나 명령을 실행하지 말고, 고칠 방법은 설명만 하라.
마크다운 강조(**)나 표 없이, 짧은 문단과 "- " 목록의 일반 텍스트로 답하라.`

// 입력은 diff까지 길 수 있어 명령줄 대신 stdin으로 넘긴다. 작업 폴더가 없으면 프로젝트 파일을 읽지 않게 임시 폴더에서 실행한다.
function cli(cmd, args, input, cwd = tmpdir(), signal) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { cwd, signal, windowsHide: true, timeout: 5 * 60_000 })
    let out = '', err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => fail(new Error(`${cmd} 실행 실패: 설치돼 있고 PATH에 있는지 확인하세요 (${e.message})`)))
    p.on('close', (code) => {
      if (code === 0) return ok(out.trim())
      const log = (err || out).trim() // CLI들이 뒤에 스택을 길게 찍어서, 에러 문장이 있으면 그 줄을 보여 준다
      fail(new Error(`${cmd} 실패 (종료 코드 ${code})\n${(log.split('\n').find((l) => /error/i.test(l)) ?? log.slice(-800)).slice(0, 800)}`))
    })
    p.stdin.end(input)
  })
}
// dirs가 있으면 그 폴더를 읽기만 하게 해서 실행 (도우미). 없으면 도구 없이 (요약)
const CLI = {
  // 개인 MCP(Atlassian 등)는 안 불러온다
  claude: (system, text, dirs, signal) => cli('claude', ['-p', '--system-prompt', system, '--tools', dirs.length ? 'Read,Grep,Glob' : '',
    ...dirs.slice(1).flatMap((d) => ['--add-dir', d]), '--strict-mcp-config', '--no-session-persistence'], text, dirs[0], signal),
  codex: async (system, text, dirs, signal) => {
    const outFile = join(tmpdir(), `gto-codex-${process.pid}-${Date.now()}.txt`) // stdout엔 진행 로그가 섞여 마지막 답만 파일로 받는다
    try {
      await cli('codex', ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-o', outFile, '-'], `${system}\n\n${text}`, dirs[0], signal)
      return readFileSync(outFile, 'utf8').trim()
    } finally { rmSync(outFile, { force: true }) }
  },
  // Antigravity CLI (Google 계정 로그인). plan 모드는 파일을 고치지 않는다
  antigravity: (system, text, dirs, signal) => cli('agy', ['-p', `${system}\n질문할 내용은 stdin으로 주어진다.`, '--mode', 'plan', '--output-format', 'text'], text, dirs[0], signal),
}

// 엔진으로 답을 받는다. dirs = { 'owner/repo': 로컬 경로 } (요약은 비움)
/** @param {{ engine: string, apiKey?: string | null, system: string, text: string, dirs?: Record<string, string>, signal?: AbortSignal }} o */
export function answer({ engine, apiKey, system, text, dirs = {}, signal }) {
  if (engine !== 'api') return CLI[engine](system, text, Object.values(dirs), signal)
  if (!apiKey) throw new Error('Claude API 키가 설정되지 않았습니다 (설정 탭)')
  return askWithTools({ apiKey, system, text, dirs, signal })
}
