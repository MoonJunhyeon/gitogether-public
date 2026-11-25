// 앱은 GitHub에만 쓴다. Jira 반영은 Actions(sync.mjs)가 이어서 처리.
export const CONFIG_REPO = 'MoonJunhyeon/gitogether'

export type Profile = {
  name: string
  repos: string[]
  label: string
  jira: { baseUrl: string; project: string; types: { epic: string; issue: string; subtask?: string } }
  mapping?: { epic?: string }
  assignees: Record<string, string> // Issue Form 담당자 이름 → Jira accountId
}
export type ProfileFile = { file: string; sha?: string; profile: Profile } // sha 없음 = 새 파일
// key = norm(마일스톤 이름). closed = 모든 레포에서 닫힘. jiraKey = 마일스톤 설명의 <!-- jira:PRJ-1 --> 표시
export type Epic = { key: string; title: string; byRepo: Record<string, number>; closed: boolean; jiraKey?: string }
// epic '' = 미분류. summarized = 요약이 있음, needsSummary = 요약 뒤에(또는 요약 없이) 기록된 커밋이 있음
// assignee = 이슈 폼의 담당자 이름 (없으면 null). id = GitHub 내부 id (하위 이슈 연결에 씀)
// parent = 상위 이슈 카드 id ("owner/repo#12", 하위 이슈일 때), subs = 하위 이슈 진행 (GitHub sub_issues_summary)
export type Issue = {
  repo: string; number: number; id: number; title: string; url: string; epic: string; state: 'open' | 'closed'
  assignee: string | null; summarized: boolean; needsSummary: boolean
  parent?: string; subs: { total: number; done: number }
  commits: string[] // 작업 기록에 쌓인 커밋 sha (기록 순서)
}

// GitHub 이슈 응답 → 카드
export const toIssue = (repo: string, i: any): Issue => ({
  repo, number: i.number, id: i.id, title: i.title, url: i.html_url, epic: i.milestone ? norm(i.milestone.title) : '',
  state: i.state, assignee: formAssignee(i.body),
  summarized: (i.body ?? '').includes(SUMMARY_START), needsSummary: needsSummary(i.body),
  subs: { total: i.sub_issues_summary?.total ?? 0, done: i.sub_issues_summary?.completed ?? 0 },
  commits: worklogCommits(i.body),
})
const repoOf = (i: { repository_url: string }) => i.repository_url.split('/repos/')[1]

// 이슈 폼 본문의 "### 담당자" 다음 첫 줄. lib.mjs의 formAssignee와 같아야 함 (테스트로 확인)
export function formAssignee(body: string | null): string | null {
  const lines = (body ?? '').replace(/\r/g, '').split('\n')
  const i = lines.findIndex((l) => l.startsWith('### 담당자'))
  if (i < 0) return null
  const name = lines.slice(i + 1).find((l) => l.trim())?.trim()
  // 이슈 폼이 빈 칸에 넣는 값: _No response_ (입력 칸), None (선택 칸)
  return name && name !== '_No response_' && name !== 'None' && !name.startsWith('###') ? name : null
}

// sync.mjs의 norm과 같아야 함 (같은 이름 마일스톤 = 같은 에픽)
export const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

let token = ''
export const setAuth = (t: string) => { token = t }

export async function gh(path: string, method = 'GET', body?: unknown, accept = 'application/vnd.github+json') {
  const r = await fetch(`${window.gto.githubApi}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: accept },
    // GitHub 응답은 60초 캐시 가능(max-age=60)이라 그대로 두면 방금 바꾼 내용이 안 보인다.
    // no-cache = 매번 ETag로 서버에 확인 (바뀐 게 없으면 304, API 한도도 안 씀)
    cache: 'no-cache',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${await r.text()}`), { status: r.status })
  return r.status === 204 ? null : r.json()
}

export async function ghAll(path: string) {
  const out = []
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    out.push(...batch)
    if (batch.length < 100) return out
  }
}

export async function loadProfiles(): Promise<ProfileFile[]> {
  const files: { name: string; sha: string }[] = await gh(`repos/${CONFIG_REPO}/contents/profiles`)
  return Promise.all(files.filter((f) => f.name.endsWith('.json')).map(async (f) => ({
    file: f.name,
    sha: f.sha,
    profile: await gh(`repos/${CONFIG_REPO}/contents/profiles/${f.name}`, 'GET', undefined, 'application/vnd.github.raw+json'),
  })))
}

// 레포 파일 읽기/커밋. sha가 다르면(그사이 다른 곳에서 수정됨) GitHub가 409로 거절한다.
export async function getFile(repo: string, path: string): Promise<{ text: string; sha: string }> {
  const { content, sha } = await gh(`repos/${repo}/contents/${path}`)
  return { text: new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\n/g, '')), (c) => c.charCodeAt(0))), sha }
}
export async function putFile(repo: string, path: string, text: string, sha: string | undefined, message: string) {
  const bytes = new TextEncoder().encode(text)
  await gh(`repos/${repo}/contents/${path}`, 'PUT', { message, content: btoa(String.fromCharCode(...bytes)), sha })
}

// Actions(sync.mjs, worklog.mjs)가 읽는 프로필은 각 레포의 Variable GTO_PROFILE. 프로필 파일 자체는 설정 레포에만 둔다.
// 토큰에 Variables 쓰기 권한(classic: repo, fine-grained: Variables write)이 필요. 반환: 실패한 레포별 메시지
// ponytail: 프로필에서 뺀 레포의 Variable은 남겨 둠, 문제가 되면 지우기 추가
export async function publishProfile(p: Profile): Promise<string[]> {
  const value = JSON.stringify(p)
  const results = await Promise.allSettled(p.repos.map(async (repo) => {
    try {
      await gh(`repos/${repo}/actions/variables/GTO_PROFILE`, 'PATCH', { name: 'GTO_PROFILE', value })
    } catch (e: any) {
      if (e.status !== 404) throw e
      await gh(`repos/${repo}/actions/variables`, 'POST', { name: 'GTO_PROFILE', value })
    }
  }))
  return results.flatMap((r, i) => (r.status === 'rejected' ? [`${p.repos[i]}: ${r.reason}`] : []))
}

export const saveProfile = ({ file, sha, profile }: ProfileFile) =>
  putFile(CONFIG_REPO, `profiles/${file}`, JSON.stringify(profile, null, 2) + '\n', sha, `profile: ${profile.name}`)

// 문제가 있으면 메시지, 없으면 null. before = 수정 전 프로필 (새 프로필이면 없음)
export function checkProfile(p: any, before?: Profile): string | null {
  if (typeof p?.name !== 'string' || !p.name.trim()) return 'name이 필요합니다'
  if (!Array.isArray(p.repos) || !p.repos.length || !p.repos.every((r: unknown) => typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r)))
    return 'repos는 "owner/repo" 문자열 배열이어야 합니다'
  if (typeof p.label !== 'string' || !p.label) return 'label이 필요합니다'
  const j = p.jira
  if (!j?.baseUrl || !j.project || !j.types?.epic || !j.types?.issue) return 'jira.baseUrl, jira.project, jira.types.epic, jira.types.issue가 필요합니다'
  if (typeof p.assignees !== 'object' || p.assignees === null) return 'assignees 객체가 필요합니다 (비어 있어도 됨)'
  // 동기화가 시작된 프로필의 에픽 매핑 방식을 바꾸면 기존 Jira 에픽 연결이 어긋난다
  if (before && before.mapping?.epic !== p.mapping?.epic) return 'mapping.epic은 바꿀 수 없습니다. 새 프로필을 만드세요'
  return null
}

// 보드 데이터: 완료(닫힌) 이슈와 에픽도 읽어 둔다 (필터로 보이고, 에픽 진행률 계산에 씀)
// ponytail: 닫힌 이슈까지 전부 읽음, 수백 개를 넘어 느려지면 최근 N개월(since)로 제한
export async function loadBoard(p: Profile) {
  const perRepo = await Promise.all(p.repos.map(async (repo) => ({
    repo,
    milestones: await ghAll(`repos/${repo}/milestones?state=all`),
    issues: await ghAll(`repos/${repo}/issues?state=all&labels=${encodeURIComponent(p.label)}`),
  })))

  const epics = new Map<string, Epic>()
  const addEpic = (repo: string, m: { title: string; number: number; state?: string; description?: string | null }) => {
    const e = epics.get(norm(m.title)) ?? { key: norm(m.title), title: m.title, byRepo: {}, closed: true }
    e.byRepo[repo] = m.number
    if (m.state !== 'closed') e.closed = false
    e.jiraKey ??= markerOf(m.description ?? null)
    epics.set(e.key, e)
  }
  for (const { repo, milestones } of perRepo) milestones.forEach((m) => addEpic(repo, m))

  const issues: Issue[] = perRepo.flatMap(({ repo, issues }) => issues
    .filter((i) => !i.pull_request)
    .map((i) => {
      if (i.milestone) addEpic(repo, i.milestone) // 닫힌 마일스톤에 걸린 이슈도 칸이 보이게
      return toIssue(repo, i)
    }))

  // 하위 이슈 표시: 하위가 있는 이슈만 목록을 읽는다 (보드에서는 상위 카드 안에 숨김)
  const byId = new Map(issues.map((i) => [`${i.repo}#${i.number}`, i]))
  await Promise.all(issues.filter((i) => i.subs.total).map(async (up) => {
    for (const s of await subIssues(up)) {
      const child = byId.get(`${s.repo}#${s.number}`)
      if (child) child.parent = `${up.repo}#${up.number}`
    }
  }))

  return { epics: [...epics.values()], issues }
}

// F5: Jira 이슈 요약 "[repo#12] 제목" → 카드 id "owner/repo#12". 옛 형식 "[GH-12]"는 레포가 하나일 때만.
export function cardIdOfSummary(summary: string, repos: string[]): string | null {
  const m = summary.match(/^\[([\w.-]+)#(\d+)\]/)
  if (m) {
    const repo = repos.find((r) => r.split('/')[1] === m[1])
    return repo ? `${repo}#${m[2]}` : null
  }
  const old = summary.match(/^\[GH-(\d+)\]/)
  return old && repos.length === 1 ? `${repos[0]}#${old[1]}` : null
}

export type JiraInfo = { key: string; status: string; category: string } // category: new | indeterminate | done

// Jira는 읽기만. 프로젝트의 (에픽 아닌) 이슈를 최근 수정순으로 읽어 카드 id에 붙인다.
export async function loadJira(p: Profile) {
  const out = new Map<string, JiraInfo>()
  let pageToken: string | undefined
  for (let i = 0; i < 10; i++) { // ponytail: 최근 1000개까지만, 넘으면 이슈 키로 직접 조회하도록 바꾸기
    const q = new URLSearchParams({
      jql: `project = ${p.jira.project} AND issuetype != ${p.jira.types.epic} ORDER BY updated DESC`,
      fields: 'summary,status',
      maxResults: '100',
    })
    if (pageToken) q.set('nextPageToken', pageToken)
    const r = await window.gto.jiraGet(p.jira.baseUrl, `3/search/jql?${q}`)
    for (const it of r.issues) {
      const id = cardIdOfSummary(it.fields.summary, p.repos)
      if (id && !out.has(id)) out.set(id, { key: it.key, status: it.fields.status.name, category: it.fields.status.statusCategory.key })
    }
    if (r.isLast || !r.nextPageToken) break
    pageToken = r.nextPageToken
  }
  return out
}

// 작업 요약: Actions(worklog.mjs)가 이슈 본문 "작업 내용" 칸에 쌓은 커밋 목록을 Claude로 요약해 같은 칸의 요약 자리에 쓴다.
// 앱이 내 토큰으로 이슈를 고치므로 issues.edited 이벤트가 생겨 동기화 Action이 Jira에도 반영한다.
const LOG_START = '<!-- gto:worklog -->'
const LOG_END = '<!-- /gto:worklog -->'
const SUMMARY_START = '<!-- gto:summary -->'
const SUMMARY_END = '<!-- /gto:summary -->'
const SUMMARIZED_RE = /<!-- gto:summarized ([0-9a-f ]*) -->/ // 요약에 반영한 커밋 SHA(앞 12자리)
const MAX_DIFF_CHARS = 300_000

const section = (body: string | null) => {
  const b = body ?? ''
  const s = b.indexOf(LOG_START)
  const e = b.indexOf(LOG_END)
  return s >= 0 && e > s ? { s, e } : null
}

// 작업 내용 칸에 기록된 커밋 SHA (링크 .../commit/<sha>)
export function worklogCommits(body: string | null): string[] {
  const sec = section(body)
  if (!sec) return []
  return [...new Set([...body!.slice(sec.s, sec.e).matchAll(/\/commit\/([0-9a-f]{40})/g)].map((m) => m[1]))]
}

// 기록된 커밋 중 아직 요약에 반영 안 된 것이 있는지
export function needsSummary(body: string | null): boolean {
  const done = (body ?? '').match(SUMMARIZED_RE)?.[1].split(' ').filter(Boolean) ?? []
  return worklogCommits(body).some((sha) => !done.some((d) => sha.startsWith(d)))
}

// 작업 내용 칸 제목 바로 아래(숨김 SHA 줄 다음)에 요약을 넣거나 바꾼다. shas = 이 요약에 반영한 커밋
export function setSummary(body: string, summary: string, date: string, shas: string[]): string {
  body = body.replace(/\r/g, '')
  const sec = section(body)
  if (!sec) throw new Error('작업 내용 칸이 없습니다')
  const marker = `<!-- gto:summarized ${shas.map((s) => s.slice(0, 12)).join(' ')} -->`
  const block = `${SUMMARY_START}\n${marker}\n**요약** (${date})\n${summary}\n${SUMMARY_END}`
  const inner = body.slice(sec.s, sec.e)
  const replaced = inner.includes(SUMMARY_START)
    ? inner.replace(new RegExp(`${SUMMARY_START}[\\s\\S]*?${SUMMARY_END}`), block)
    : inner.replace(/(<!-- gto:shas [0-9a-f ]* -->\n?)/, `$1${block}\n`)
  return body.slice(0, sec.s) + replaced + body.slice(sec.e)
}

// 이슈 하나 요약 (기록된 커밋 전체를 다시 요약해서 교체)
export async function summarizeIssue(issue: Issue, withDiff: boolean) {
  const { title, body } = await gh(`repos/${issue.repo}/issues/${issue.number}`)
  const shas = worklogCommits(body)
  if (!shas.length) throw new Error(`#${issue.number}: 기록된 커밋이 없습니다`)
  const commits = await Promise.all(shas.map((sha) => gh(`repos/${issue.repo}/commits/${sha}`)))
  const files = commits.flatMap((c) => c.files ?? [])
  let text = [
    `이슈 #${issue.number}: ${title}`,
    `커밋:\n${commits.map((c) => `- ${c.commit.message}`).join('\n')}`,
    `변경 파일:\n${files.map((f: any) => `- ${f.filename} (+${f.additions} -${f.deletions})`).join('\n')}`,
  ].join('\n\n')
  if (withDiff) {
    let budget = MAX_DIFF_CHARS
    for (const f of files) {
      if (!f.patch) continue
      if (f.patch.length > budget) { text += '\n\n(나머지 파일 diff는 너무 커서 생략)'; break }
      text += `\n\n--- ${f.filename}\n${f.patch}`
      budget -= f.patch.length
    }
  }
  const summary = await window.gto.summarize(text)
  const date = new Date().toLocaleDateString('sv-SE')
  // 요약하는 사이 Actions가 커밋을 더 기록했을 수 있으니 다시 읽어서 그 위에 쓴다
  const latest = await gh(`repos/${issue.repo}/issues/${issue.number}`)
  await gh(`repos/${issue.repo}/issues/${issue.number}`, 'PATCH', { body: setSummary(latest.body, summary, date, shas) })
}

// 드래그: 그 레포에 같은 이름 마일스톤이 없으면 만들고 붙인다
export async function assign(issue: Issue, epic: Epic | undefined) {
  let number: number | null = null
  if (epic) {
    number = epic.byRepo[issue.repo] ??
      (epic.byRepo[issue.repo] = (await gh(`repos/${issue.repo}/milestones`, 'POST', { title: epic.title })).number)
  }
  await gh(`repos/${issue.repo}/issues/${issue.number}`, 'PATCH', { milestone: number })
}

// 이름 변경, 닫기: 그 에픽에 속한 모든 레포의 마일스톤에 일괄 적용
export const renameEpic = (e: Epic, title: string) =>
  Promise.all(Object.entries(e.byRepo).map(([repo, n]) => gh(`repos/${repo}/milestones/${n}`, 'PATCH', { title })))
export const closeEpic = (e: Epic) =>
  Promise.all(Object.entries(e.byRepo).map(([repo, n]) => gh(`repos/${repo}/milestones/${n}`, 'PATCH', { state: 'closed' })))

// 에픽 만들기: 프로필의 모든 레포에 같은 이름 마일스톤 (이미 있으면 422, 무시)
export async function createEpic(p: Profile, title: string) {
  await Promise.all(p.repos.map((repo) =>
    gh(`repos/${repo}/milestones`, 'POST', { title }).catch((e) => { if (e.status !== 422) throw e })))
}

// 이슈 본문: 레포의 Issue Form(task.yml)과 같은 형식이라 동기화가 "### 담당자"를 그대로 읽는다
export const issueBody = (assignee: string, content: string) =>
  `### 담당자\n\n${assignee || '_No response_'}\n\n### 내용\n\n${content.trim() || '_No response_'}`

// 보드에서 이슈 만들기: 동기화 대상 라벨을 붙이고, 칸(에픽)의 마일스톤에 넣는다 (그 레포에 없으면 만듦)
export async function createIssue(p: Profile, o: { repo: string; title: string; assignee: string; content: string; epic?: Epic }) {
  const milestone = o.epic
    ? o.epic.byRepo[o.repo] ?? (o.epic.byRepo[o.repo] = (await gh(`repos/${o.repo}/milestones`, 'POST', { title: o.epic.title })).number)
    : undefined
  await gh(`repos/${o.repo}/issues`, 'POST', {
    title: o.title, body: issueBody(o.assignee, o.content), labels: [p.label], milestone,
  })
}

// 하위 이슈 목록 (라벨 없는 것도 포함, 다른 레포 이슈일 수 있음)
export const subIssues = async (up: Issue): Promise<Issue[]> =>
  (await ghAll(`repos/${up.repo}/issues/${up.number}/sub_issues`)).map((i) => toIssue(repoOf(i), i))

// 하위 작업 만들기: 라벨 없이 만들고 → 상위에 하위 이슈로 연결 → 마지막에 동기화 라벨.
// 라벨을 붙일 때(labeled) 동기화가 돌아서, 그때는 상위가 있으니 Jira 하위 작업으로 만들어진다.
// 마일스톤은 상위와 같게 (보드 진행률, 필터용. Jira 하위 작업은 상위를 따라감)
export async function createSubIssue(p: Profile, up: Issue, o: { title: string; assignee: string; content: string }) {
  const { milestone } = await gh(`repos/${up.repo}/issues/${up.number}`)
  const created = await gh(`repos/${up.repo}/issues`, 'POST', {
    title: o.title, body: issueBody(o.assignee, o.content), milestone: milestone?.number,
  })
  try {
    await gh(`repos/${up.repo}/issues/${up.number}/sub_issues`, 'POST', { sub_issue_id: created.id })
  } catch (e) {
    throw new Error(`#${created.number}은 만들었지만 #${up.number}의 하위로 연결하지 못했습니다 (라벨도 안 붙임): ${e}`)
  }
  await gh(`repos/${up.repo}/issues/${created.number}/labels`, 'POST', { labels: [p.label] })
}

// GitHub 이슈 → Jira 키 (동기화가 남긴 "Jira: [PRJ-12]" 코멘트). Jira 토큰 없이도 알 수 있다.
export async function jiraKeyOfIssue(issue: Issue): Promise<string | null> {
  const comments: { body?: string }[] = await gh(`repos/${issue.repo}/issues/${issue.number}/comments?per_page=100`)
  return comments.map((c) => c.body?.match(/^Jira: \[([A-Z][A-Z0-9]+-\d+)\]/)?.[1]).find(Boolean) ?? null
}

export type JiraIssue = {
  key: string
  fields: {
    summary: string
    status: { name: string; statusCategory: { key: string } }
    issuetype: { name: string }
    assignee: { displayName: string } | null
    reporter: { displayName: string } | null
    priority: { name: string } | null
    parent?: { key: string; fields: { summary: string } }
    duedate: string | null
    created: string
    updated: string
  }
  renderedFields: { description: string | null }
}

// Jira에서 보이는 모습 그대로 (설명은 Jira가 렌더링한 HTML)
export const loadJiraIssue = (p: Profile, key: string): Promise<JiraIssue> =>
  window.gto.jiraGet(p.jira.baseUrl,
    `2/issue/${key}?expand=renderedFields&fields=summary,status,issuetype,assignee,reporter,priority,parent,duedate,created,updated,description`)

// ── Jira에 이미 있는 에픽을 마일스톤으로 한 번 가져오기 (이후로는 GitHub → Jira 한 방향) ──
export type JiraEpic = { key: string; summary: string; status: string; category: string; linked: boolean }
// 마일스톤 설명의 <!-- jira:PRJ-123 --> 표시 → PRJ-123 (sync.mjs MARKER_RE와 같은 형식)
export const markerOf = (desc: string | null) => desc?.match(/<!-- jira:([A-Z][A-Z0-9]+-\d+) -->/)?.[1]

async function jiraSearch(p: Profile, jql: string, fields: string) {
  // ponytail: 100개까지만, 넘으면 nextPageToken 페이지네이션
  return (await window.gto.jiraGet(p.jira.baseUrl,
    `3/search/jql?${new URLSearchParams({ jql, fields, maxResults: '100' })}`)).issues as any[]
}

// 끝나지 않은 에픽 목록. linked = 이미 어떤 마일스톤 설명에 이 에픽 표시가 있음
export async function loadJiraEpics(p: Profile): Promise<JiraEpic[]> {
  const [issues, milestones] = await Promise.all([
    jiraSearch(p, `project = ${p.jira.project} AND issuetype = ${p.jira.types.epic} AND statusCategory != Done ORDER BY created DESC`, 'summary,status'),
    Promise.all(p.repos.map((r) => ghAll(`repos/${r}/milestones?state=all`))).then((x) => x.flat()),
  ])
  const linked = new Set(milestones.map((m) => markerOf(m.description)).filter(Boolean))
  return issues.map((i) => ({
    key: i.key, summary: i.fields.summary, status: i.fields.status.name,
    category: i.fields.status.statusCategory.key, linked: linked.has(i.key),
  }))
}

// 에픽 하나 → 모든 레포에 같은 이름 마일스톤 (있으면 표시만 추가). 설명은 Jira 에픽 설명을 그대로 옮긴다:
// 동기화는 마일스톤이 원본이라, 비워 두면 마일스톤을 고칠 때 Jira 에픽 설명이 지워진다.
// 그 에픽에 속한 Jira 작업의 GitHub 이슈에도 같은 마일스톤을 지정한다 (마일스톤이 없는 이슈만).
export async function importEpic(p: Profile, epic: JiraEpic) {
  const { fields } = await window.gto.jiraGet(p.jira.baseUrl, `2/issue/${epic.key}?fields=description`)
  const marker = `<!-- jira:${epic.key} -->`
  const description = `${fields.description ?? ''}\n\n${marker}`.trim()
  const numbers: Record<string, number> = {}
  for (const repo of p.repos) {
    const existing = (await ghAll(`repos/${repo}/milestones?state=all`)).find((m) => norm(m.title) === norm(epic.summary))
    numbers[repo] = existing
      ? (existing.description?.includes(marker) ? existing
        : await gh(`repos/${repo}/milestones/${existing.number}`, 'PATCH', { description: `${existing.description ?? ''}\n\n${marker}`.trim() })).number
      : (await gh(`repos/${repo}/milestones`, 'POST', { title: epic.summary, description })).number
  }
  const assigned: string[] = []
  const skipped: string[] = []
  for (const t of await jiraSearch(p, `parent = ${epic.key}`, 'summary')) {
    const id = cardIdOfSummary(t.fields.summary, p.repos)
    if (!id) continue // GitHub 이슈와 연결 안 된 Jira 작업
    const [repo, n] = id.split('#')
    const issue = await gh(`repos/${repo}/issues/${n}`)
    if (!issue.milestone) {
      await gh(`repos/${repo}/issues/${n}`, 'PATCH', { milestone: numbers[repo] })
      assigned.push(`#${n}`)
    } else if (norm(issue.milestone.title) !== norm(epic.summary)) {
      skipped.push(`#${n}(이미 "${issue.milestone.title}")`)
    }
  }
  return { assigned, skipped }
}

// 이슈 열기/닫기. 닫으면 동기화가 Jira 작업을 완료로, 다시 열면 할 일로 바꾼다
export const setIssueState = (i: Issue, state: 'open' | 'closed') =>
  gh(`repos/${i.repo}/issues/${i.number}`, 'PATCH', state === 'closed' ? { state, state_reason: 'completed' } : { state })
