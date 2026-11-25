// gto 스크립트(sync, worklog) 공용. Actions에서 대상 레포의 .github/gto/ 에 같이 복사해서 쓴다.
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const KEY = '([A-Z][A-Z0-9]+-\\d+)'
export const COMMENT_RE = new RegExp(`^Jira: \\[${KEY}\\]`)
export const MARKER_RE = new RegExp(`<!-- jira:${KEY} -->`)

export const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// Issue Form의 "### 담당자" 다음 첫 줄
export function formAssignee(body) {
  const lines = (body ?? '').replace(/\r/g, '').split('\n')
  const i = lines.findIndex((l) => l.startsWith('### 담당자'))
  if (i < 0) return null
  const name = lines.slice(i + 1).find((l) => l.trim())?.trim()
  // 이슈 폼이 빈 칸에 넣는 값: _No response_ (입력 칸), None (선택 칸)
  return name && name !== '_No response_' && name !== 'None' && !name.startsWith('###') ? name : null
}

// 텍스트에서 이슈 번호 모으기: "#12", 커밋 규칙의 "feat(#12) : ...". 같은 레포 이슈만 (owner/repo#12 제외).
// #0은 커밋 규칙에서 "이슈 없음"이라 뺀다.
export const issueRefs = (text) =>
  [...new Set([...(text ?? '').matchAll(/(?<![\w/])#(\d+)\b/g)].map((m) => Number(m[1])))].filter((n) => n > 0)

export const env = process.env
export const repo = env.GITHUB_REPOSITORY

// 프로필: GTO_PROFILE(JSON, 레포 Variables 등) 우선, 없으면 옆의 profiles/*.json 중 이 레포가 든 것
export function loadProfile() {
  if (env.GTO_PROFILE) return JSON.parse(env.GTO_PROFILE)
  const dir = new URL('profiles/', import.meta.url)
  if (!existsSync(dir)) return undefined // Variable도 파일도 없음 → 스크립트가 "프로필 없음"으로 건너뜀
  return readdirSync(dir)
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')))
    .find((x) => x.repos.includes(repo))
}
export const p = repo ? loadProfile() : undefined

async function call(url, auth, method, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body && JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${await r.text()}`)
  return r.status === 204 ? null : r.json()
}
export const jira = (method, path, body) =>
  call(`${p.jira.baseUrl}/rest/api/${path}`,
    'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64'), method, body)
export const gh = (method, path, body) =>
  call(`https://api.github.com/repos/${repo}/${path}`, `Bearer ${env.GH_TOKEN}`, method, body)

// GitHub 이슈 → Jira 키 (sync가 남긴 "Jira: [PRJ-12]" 코멘트)
export async function jiraKeyOf(number) {
  const comments = await gh('GET', `issues/${number}/comments?per_page=100`)
  return comments.map((c) => c.body?.match(COMMENT_RE)?.[1]).find(Boolean) ?? null
}

// 하위 이슈(sub-issue)면 상위 이슈, 아니면 null
export async function parentOf(number) {
  try {
    return await gh('GET', `issues/${number}/parent`)
  } catch (e) {
    if (e.message.includes('→ 404')) return null
    throw e
  }
}
