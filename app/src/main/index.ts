import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, safeStorage, shell } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sodium from 'libsodium-wrappers'
import { answer, ASK_SYSTEM, ENGINES, REPO, SUMMARY_SYSTEM, syncRepo, workspaceNote } from '../../codebase.mjs'

// 토큰은 OS 키체인으로 암호화해 이 PC의 userData에만 저장
const file = (name: string) => join(app.getPath('userData'), name)
const read = (name: string) => (existsSync(file(name)) ? safeStorage.decryptString(readFileSync(file(name))) : null)
const write = (name: string, value: string) => writeFileSync(file(name), safeStorage.encryptString(value))

ipcMain.handle('token:get', () => read('github-token'))
ipcMain.handle('token:set', (_e, token: string) => write('github-token', token))

// 화면 테마: 시스템 설정을 따르거나 라이트/다크로 고정. 비밀이 아니라 평문 settings.json에 둔다
type Theme = 'system' | 'light' | 'dark'
const THEMES: Theme[] = ['system', 'light', 'dark']
const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const readSettings = (): { theme?: Theme; engine?: Engine; dirs?: Record<string, string> } => { try { return JSON.parse(readFileSync(settingsFile(), 'utf8')) } catch { return {} } }
ipcMain.handle('theme:get', () => nativeTheme.themeSource)
ipcMain.handle('theme:set', (_e, theme: Theme) => {
  if (!THEMES.includes(theme)) throw new Error(`알 수 없는 테마: ${theme}`)
  nativeTheme.themeSource = theme // 화면(prefers-color-scheme)과 창 버튼 색이 'updated' 이벤트로 함께 바뀐다
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), theme }))
})

// Jira 토큰은 렌더러로 내보내지 않는다. 조회(GET)만 메인에서 대신 한다. (Jira는 CORS로 렌더러에서 직접 못 부름)
ipcMain.handle('jira:set', (_e, email: string, token: string) => write('jira-auth', JSON.stringify({ email, token })))
ipcMain.handle('jira:configured', () => read('jira-auth') !== null)
ipcMain.handle('jira:get', async (_e, baseUrl: string, path: string) => {
  const auth = read('jira-auth')
  if (!auth) throw new Error('Jira 토큰이 설정되지 않았습니다 (설정 탭)')
  if (!/^https:\/\/[\w-]+\.atlassian\.net$/.test(baseUrl)) throw new Error(`허용되지 않은 Jira 주소: ${baseUrl}`)
  const { email, token } = JSON.parse(auth)
  const r = await fetch(`${baseUrl}/rest/api/${path}`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64'), Accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`Jira GET ${path} → ${r.status} ${await r.text()}`)
  return r.json()
})

// 작업 요약과 도우미는 앱에서만 한다. 엔진은 API 키(렌더러로 내보내지 않음) 또는 이 PC에 로그인된 CLI(각자 구독 요금제로 실행). 실행은 codebase.mjs
type Engine = 'api' | 'claude' | 'codex' | 'antigravity'
const engine = (): Engine => (ENGINES.includes(readSettings().engine!) ? readSettings().engine! : 'api') // 예전 값(gemini 등)은 API 키로
ipcMain.handle('summary:engine', () => engine())
ipcMain.handle('summary:setEngine', (_e, e: Engine) => {
  if (!ENGINES.includes(e)) throw new Error(`알 수 없는 요약 엔진: ${e}`)
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), engine: e }))
})
ipcMain.handle('claude:set', (_e, key: string) => write('claude-key', key))
ipcMain.handle('claude:configured', () => engine() !== 'api' || read('claude-key') !== null)
ipcMain.handle('claude:summarize', (_e, text: string) => answer({ engine: engine(), apiKey: read('claude-key'), system: SUMMARY_SYSTEM, text }))

// 프로젝트 도우미: 직접 고른 폴더가 있으면 그것, 없으면 앱이 userData/repos에 얕게 clone해 두고 10분마다 최신으로 맞춘다.
// 렌더러는 레포 이름만 넘기고 경로는 메인이 정한다. GitHub에는 받기만 한다
const dirs = () => readSettings().dirs ?? {}
ipcMain.handle('assistant:dirs', () => dirs())
ipcMain.handle('assistant:pickDir', async (_e, repo: string) => {
  const r = await dialog.showOpenDialog({ title: `${repo} 로컬 폴더`, properties: ['openDirectory'] })
  if (r.canceled || !r.filePaths[0]) return null
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), dirs: { ...dirs(), [repo]: r.filePaths[0] } }))
  return r.filePaths[0]
})
ipcMain.handle('assistant:autoDir', (_e, repo: string) => {
  const { [repo]: _, ...rest } = dirs()
  writeFileSync(settingsFile(), JSON.stringify({ ...readSettings(), dirs: rest }))
})
// 코드: 직접 고른 폴더가 있으면 그것, 없으면 userData/repos의 로컬 저장소를 질문할 때마다 최신으로 맞춘다 (codebase.mjs)
const codeDir = (repo: string): Promise<string> => {
  const own = dirs()[repo]
  return own && existsSync(own) ? Promise.resolve(own) : syncRepo(join(app.getPath('userData'), 'repos'), repo, read('github-token'))
}

// 질문마다 id를 받아 두고 "중지"하면 CLI 프로세스나 API 요청을 끊는다 (받는 중인 코드는 끝까지 받는다)
const asking = new Map<string, AbortController>()
ipcMain.handle('assistant:cancel', (_e, id: string) => asking.get(id)?.abort())
ipcMain.handle('assistant:ask', async (_e, id: string, text: string, repos: string[]) => {
  const ac = new AbortController()
  asking.set(id, ac)
  try {
    const ds = await Promise.all(repos.map(codeDir))
    const byRepo = Object.fromEntries(repos.map((r, i) => [r, ds[i]]))
    const prompt = text + await workspaceNote(byRepo, repos.filter((r) => dirs()[r]))
    ac.signal.throwIfAborted()
    return await answer({ engine: engine(), apiKey: read('claude-key'), system: ASK_SYSTEM, text: prompt, dirs: byRepo, signal: ac.signal })
  } finally { asking.delete(id) }
})

async function github(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${read('github-token')}`, Accept: 'application/vnd.github+json', ...init.headers },
  })
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${r.status} ${await r.text()}`)
  return r
}

// 잡 로그는 다른 호스트로 리다이렉트돼서 렌더러에서는 CORS에 막힌다
ipcMain.handle('gh:jobLog', async (_e, repo: string, jobId: number) => {
  if (!REPO.test(repo) || !Number.isInteger(jobId)) throw new Error('잘못된 요청')
  return (await github(`repos/${repo}/actions/jobs/${jobId}/logs`)).text()
})

// Secrets 등록: 레포 공개키로 봉인(libsodium sealed box)해서 PUT
ipcMain.handle('gh:putSecret', async (_e, repo: string, name: string, value: string) => {
  if (!REPO.test(repo) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('잘못된 레포 또는 Secret 이름')
  await sodium.ready
  const { key, key_id } = await (await github(`repos/${repo}/actions/secrets/public-key`)).json()
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key, sodium.base64_variants.ORIGINAL))
  await github(`repos/${repo}/actions/secrets/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id }),
  })
})

// 기본 제목 표시줄 대신 앱이 그리는 제목 표시줄(renderer .titlebar). 창 버튼(최소화/최대화/닫기)은 OS 것을 쓰되
// 색만 앱 테마(styles.css의 --chrome, --muted-foreground)에 맞춘다. 높이는 .titlebar(40px)에서 아래 테두리 1px를 뺀 값.
const isMac = process.platform === 'darwin'
const overlay = () => nativeTheme.shouldUseDarkColors
  ? { color: '#1c1c1e', symbolColor: '#98989d', height: 39 }
  : { color: '#ffffff', symbolColor: '#6e6e73', height: 39 }

// Windows 작업 표시줄이 개발 중에도 electron.exe가 아닌 이 앱으로 묶이도록
if (process.platform === 'win32') app.setAppUserModelId('com.gitogether.app')

app.whenReady().then(() => {
  Menu.setApplicationMenu(null) // File/Edit/View 기본 메뉴 바 제거
  // 저장해 둔 테마를 창을 만들기 전에 적용 (켤 때 다른 테마가 잠깐 보이지 않게)
  const saved = readSettings().theme
  if (saved && THEMES.includes(saved)) nativeTheme.themeSource = saved
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Gitogether',
    icon: join(__dirname, '../../resources/icon.png'), // 창, 작업 표시줄 아이콘 (원본 resources/icon.svg)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    titleBarStyle: 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: overlay() }),
    webPreferences: { preload: join(__dirname, '../preload/index.js') },
  })
  nativeTheme.on('updated', () => {
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff')
    if (!isMac) win.setTitleBarOverlay(overlay())
  })
  // 링크는 앱 안이 아니라 브라우저에서 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(github\.com|[\w-]+\.atlassian\.net)\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
})

app.on('window-all-closed', () => app.quit())
