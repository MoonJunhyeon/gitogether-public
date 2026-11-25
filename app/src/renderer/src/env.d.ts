/// <reference types="vite/client" />

interface Window {
  gto: {
    platform: string
    githubApi: string // Electron은 api.github.com 직접, 웹은 서버 중계(/api/github)
    getTheme(): Promise<'system' | 'light' | 'dark'>
    setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>
    getToken(): Promise<string | null>
    setToken(token: string): Promise<void>
    setJira(email: string, token: string): Promise<void>
    jiraConfigured(): Promise<boolean>
    jiraGet(baseUrl: string, path: string): Promise<any>
    setClaudeKey(key: string): Promise<void>
    claudeConfigured(): Promise<boolean>
    getEngine(): Promise<'api' | 'claude' | 'codex' | 'antigravity'>
    setEngine(engine: 'api' | 'claude' | 'codex' | 'antigravity'): Promise<void>
    summarize(text: string): Promise<string>
    ask(id: string, text: string, repos: string[]): Promise<string>
    cancelAsk(id: string): Promise<void>
    autoRepoDir(repo: string): Promise<void>
    repoDirs(): Promise<Record<string, string>>
    pickRepoDir(repo: string): Promise<string | null>
    jobLog(repo: string, jobId: number): Promise<string>
    putSecret(repo: string, name: string, value: string): Promise<void>
  }
}
