// 브라우저(웹 버전)에서는 preload가 없으니 같은 window.gto를 server.mjs 호출로 채운다. 토큰은 서버에만 있다.
type Theme = 'system' | 'light' | 'dark'

async function call(name: string, ...args: unknown[]) {
  const r = await fetch(`/api/${name}`, { method: 'POST', body: JSON.stringify(args) })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

// 다크 색은 styles.css의 @media (prefers-color-scheme: dark) 한 곳에 있다. 라이트/다크 고정은 그 조건을 바꿔서 한다
function applyTheme(theme: Theme) {
  const media = theme === 'dark' ? 'all' : theme === 'light' ? 'not all' : '(prefers-color-scheme: dark)'
  for (const sheet of Array.from(document.styleSheets))
    for (const rule of Array.from(sheet.cssRules))
      if (rule instanceof CSSMediaRule && /prefers-color-scheme|^all$|^not all$/.test(rule.media.mediaText)) rule.media.mediaText = media
}
const savedTheme = (): Theme => { try { return (localStorage.getItem('gto-theme') as Theme) ?? 'system' } catch { return 'system' } }

if (!window.gto) {
  window.gto = {
    platform: 'web',
    githubApi: '/api/github',
    getTheme: async () => savedTheme(),
    setTheme: async (theme) => { try { localStorage.setItem('gto-theme', theme) } catch {} applyTheme(theme) },
    getToken: () => call('token:get'),
    setToken: (token) => call('token:set', token),
    setJira: (email, token) => call('jira:set', email, token),
    jiraConfigured: () => call('jira:configured'),
    jiraGet: (baseUrl, path) => call('jira:get', baseUrl, path),
    setClaudeKey: (key) => call('claude:set', key),
    claudeConfigured: () => call('claude:configured'),
    getEngine: () => call('summary:engine'), // CLI는 서버 PC에 로그인된 계정을 접속한 모두가 함께 쓴다
    setEngine: (engine) => call('summary:setEngine', engine),
    summarize: (text) => call('claude:summarize', text),
    ask: (_id, text, repos) => call('assistant:ask', text, repos), // 서버가 자기 로컬 저장소를 최신으로 맞추고 읽는다
    cancelAsk: async () => {}, // 서버 요청은 끊지 않고 화면에서 답을 버린다
    autoRepoDir: async () => {},
    repoDirs: async () => ({}),
    pickRepoDir: async () => null,
    jobLog: (repo, jobId) => call('gh:jobLog', repo, jobId),
    putSecret: (repo, name, value) => call('gh:putSecret', repo, name, value),
  }
  if (savedTheme() !== 'system') {
    applyTheme(savedTheme())
    window.addEventListener('load', () => applyTheme(savedTheme())) // 스타일시트가 늦게 붙는 경우
  }
}
