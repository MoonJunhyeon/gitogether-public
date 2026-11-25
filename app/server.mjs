// 웹 버전 서버: 빌드된 화면(out/web)을 주고, Electron 메인 프로세스(src/main/index.ts)가 하던 일을 HTTP로 대신 한다.
// 토큰은 서버의 data/secrets.json에 저장하고 브라우저로는 내보내지 않는다. GitHub 호출도 /api/github/로 중계하며 서버가 토큰을 붙인다.
// 실행: npm run web   환경 변수: GTO_PORT(기본 8080), GTO_PASSWORD(접속 비밀번호, 한 번 넣으면 쿠키로 기억), GTO_DATA(저장 폴더), GTO_CERT/GTO_KEY(HTTPS)
import { createServer } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import sodium from 'libsodium-wrappers'
import { answer, ASK_SYSTEM, ENGINES, REPO, SUMMARY_SYSTEM, syncRepo, workspaceNote } from './codebase.mjs'

const ROOT = resolve(import.meta.dirname, 'out/web')
const DATA = resolve(process.env.GTO_DATA ?? join(import.meta.dirname, 'data'))
const PASSWORD = process.env.GTO_PASSWORD ?? ''
if (!PASSWORD) console.warn('경고: GTO_PASSWORD가 없어 접속한 누구나 저장된 토큰 권한으로 GitHub에 쓸 수 있습니다.')

// 토큰 저장 (평문 파일, 서버 계정만 읽기)
const secretsFile = join(DATA, 'secrets.json')
const secrets = () => (existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {})
const save = (patch) => {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(secretsFile, JSON.stringify({ ...secrets(), ...patch }), { mode: 0o600 })
}

async function github(path, init = {}) {
  const r = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secrets().github}`, Accept: 'application/vnd.github+json', ...init.headers },
  })
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${await r.text()}`)
  return r
}

// 작업 요약·도우미 엔진: API 키 또는 이 서버 PC에 로그인된 CLI (접속한 모두가 그 계정을 함께 쓴다). 비밀이 아니라 settings.json에 둔다
const settingsFile = join(DATA, 'settings.json')
const settings = () => (existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {})
const engine = () => (ENGINES.includes(settings().engine) ? settings().engine : 'api')

// preload/index.ts의 ipc 채널과 같은 이름
const handlers = {
  'token:get': () => (secrets().github ? 'server' : null), // 토큰 대신 "설정됨" 표시만
  'token:set': (token) => save({ github: token }),
  'jira:set': (email, token) => save({ jira: { email, token } }),
  'jira:configured': () => !!secrets().jira,
  'jira:get': async (baseUrl, path) => {
    const { jira } = secrets()
    if (!jira) throw new Error('Jira 토큰이 설정되지 않았습니다 (설정 탭)')
    if (!/^https:\/\/[\w-]+\.atlassian\.net$/.test(baseUrl)) throw new Error(`허용되지 않은 Jira 주소: ${baseUrl}`)
    if (typeof path !== 'string' || path.includes('..')) throw new Error('잘못된 Jira 경로')
    const r = await fetch(`${baseUrl}/rest/api/${path}`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${jira.email}:${jira.token}`).toString('base64'), Accept: 'application/json' },
    })
    if (!r.ok) throw new Error(`Jira GET ${path} → ${r.status} ${await r.text()}`)
    return r.json()
  },
  'claude:set': (key) => save({ claude: key }),
  'claude:configured': () => engine() !== 'api' || !!secrets().claude,
  'summary:engine': () => engine(),
  'summary:setEngine': (e) => {
    if (!ENGINES.includes(e)) throw new Error(`알 수 없는 요약 엔진: ${e}`)
    mkdirSync(DATA, { recursive: true })
    writeFileSync(settingsFile, JSON.stringify({ ...settings(), engine: e }))
  },
  'claude:summarize': (text) => answer({ engine: engine(), apiKey: secrets().claude, system: SUMMARY_SYSTEM, text: String(text) }),
  // 서버에 레포마다 로컬 저장소를 하나 두고(data/repos) 질문할 때마다 최신으로 맞춘 뒤 엔진이 읽기 전용으로 읽으며 답한다
  'assistant:ask': async (text, repos = []) => {
    const { claude: apiKey, github: token } = secrets()
    if (engine() === 'api' && !apiKey) throw new Error('Claude API 키가 설정되지 않았습니다 (설정 탭)')
    if (!Array.isArray(repos) || !repos.every((r) => typeof r === 'string' && REPO.test(r))) throw new Error('잘못된 레포')
    const ds = await Promise.all(repos.map((r) => syncRepo(join(DATA, 'repos'), r, token)))
    const dirs = Object.fromEntries(repos.map((r, i) => [r, ds[i]]))
    return answer({ engine: engine(), apiKey, system: ASK_SYSTEM, text: String(text) + await workspaceNote(dirs), dirs })
  },
  'gh:jobLog': async (repo, jobId) => {
    if (!REPO.test(repo) || !Number.isInteger(jobId)) throw new Error('잘못된 요청')
    return (await github(`repos/${repo}/actions/jobs/${jobId}/logs`)).text()
  },
  'gh:putSecret': async (repo, name, value) => {
    if (!REPO.test(repo) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('잘못된 레포 또는 Secret 이름')
    await sodium.ready
    const { key, key_id } = await (await github(`repos/${repo}/actions/secrets/public-key`)).json()
    const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL))
    await github(`repos/${repo}/actions/secrets/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id }),
    })
  },
}

// 비밀번호를 한 번 맞히면 쿠키로 1년 기억 (주소에 ?key=비밀번호를 붙여 즐겨찾기하면 입력 없이 열림)
const SESSION = createHash('sha256').update('gto:' + PASSWORD).digest('hex')
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const cookieOf = (req) => /(?:^|;\s*)gto=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gitogether</title>
<style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f2f2f7}@media(prefers-color-scheme:dark){body{background:#1c1c1e;color:#f5f5f7}}
form{display:flex;gap:8px}input,button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #8884}button{background:#007aff;color:#fff;border:0}</style>
<form><input type="password" name="key" placeholder="접속 비밀번호" autofocus><button>열기</button></form>`

const readBody = (req) => new Promise((ok, fail) => {
  const chunks = []
  let size = 0
  req.on('data', (c) => { size += c.length; if (size > 10 * 1024 * 1024) { fail(new Error('요청이 너무 큽니다')); req.destroy() } else chunks.push(c) })
  req.on('end', () => ok(Buffer.concat(chunks)))
  req.on('error', fail)
})

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  if (PASSWORD && !same(cookieOf(req), SESSION)) {
    const key = url.searchParams.get('key')
    if (key !== null && same(key, PASSWORD)) {
      res.writeHead(302, { 'Set-Cookie': `gto=${SESSION}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`, Location: '/' }).end()
    } else {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }).end(LOGIN_PAGE)
    }
    return
  }

  // GitHub REST 중계: 브라우저 요청의 Authorization은 버리고 서버 토큰을 붙인다
  if (url.pathname.startsWith('/api/github/')) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req)
    const r = await fetch(`https://api.github.com/${url.pathname.slice('/api/github/'.length)}${url.search}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${secrets().github}`,
        Accept: req.headers.accept ?? 'application/vnd.github+json',
        ...(req.headers['if-none-match'] && { 'If-None-Match': req.headers['if-none-match'] }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body,
    })
    const headers = {}
    for (const h of ['content-type', 'etag', 'link']) if (r.headers.get(h)) headers[h] = r.headers.get(h)
    res.writeHead(r.status, headers).end(Buffer.from(await r.arrayBuffer()))
    return
  }

  if (url.pathname.startsWith('/api/')) {
    const fn = handlers[url.pathname.slice('/api/'.length)]
    if (!fn || req.method !== 'POST') return void res.writeHead(404).end()
    try {
      const args = JSON.parse((await readBody(req)).toString() || '[]')
      const out = await fn(...(Array.isArray(args) ? args : []))
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out ?? null))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(String(e?.message ?? e))
    }
    return
  }

  // 화면 파일
  const file = resolve(ROOT, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
  if (!file.startsWith(ROOT + sep) || !existsSync(file)) return void res.writeHead(404).end()
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
}

const listener = (req, res) => handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(502).end(String(e?.message ?? e)) })
const port = Number(process.env.GTO_PORT ?? 8080)
const server = process.env.GTO_CERT && process.env.GTO_KEY
  ? createHttps({ cert: readFileSync(process.env.GTO_CERT), key: readFileSync(process.env.GTO_KEY) }, listener)
  : createServer(listener)
server.listen(port, () => console.log(`Gitogether 웹: ${process.env.GTO_CERT ? 'https' : 'http'}://localhost:${port}`))
