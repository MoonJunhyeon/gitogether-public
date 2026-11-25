// 이슈 → Jira → 커밋 → 개발 배포 → 태그 → 배포. 앱은 읽기만 한다.
// 판단 기준: 이슈 본문 작업 기록의 마지막 커밋이 어느 태그에 들어갔는지 (GitHub compare)
import { gh, ghAll, type Issue, type JiraInfo } from './github.ts'

export type StageState = 'done' | 'active' | 'fail' | 'todo'
export type Stage = { label: string; state: StageState; text: string; url?: string }
type Tag = { name: string; sha: string }
// 이슈 하나의 배포 쪽 정보 (없으면 아직 확인 전)
export type Release = {
  dev?: { name: string; url: string } // 마지막 커밋이 들어간 프리릴리스 (예: develop-latest)
  tag?: { name: string; url: string } // 마지막 커밋이 처음 들어간 정식 태그
  deploy?: { state: StageState; text: string; url?: string } // 그 태그의 릴리스 / 빌드
}

export const STAGES = ['이슈', 'Jira', '커밋', '개발 배포', '태그', '배포'] as const

export function stagesOf(issue: Issue, jira: JiraInfo | undefined, rel: Release | undefined, jiraBase?: string): Stage[] {
  const n = issue.commits.length
  const last = issue.commits[n - 1]
  const checking = n > 0 && !rel
  return [
    { label: '이슈', state: 'done', text: issue.state === 'closed' ? '닫힘' : '열림', url: issue.url },
    jira
      ? { label: 'Jira', state: 'done', text: `${jira.key} ${jira.status}`, url: jiraBase && `${jiraBase}/browse/${jira.key}` }
      : { label: 'Jira', state: 'todo', text: '연결 전' },
    n ? { label: '커밋', state: 'done', text: `${n}개`, url: `https://github.com/${issue.repo}/commit/${last}` }
      : { label: '커밋', state: 'todo', text: '없음' },
    rel?.dev ? { label: '개발 배포', state: 'done', text: rel.dev.name, url: rel.dev.url }
      : { label: '개발 배포', state: 'todo', text: checking ? '확인 중' : '-' },
    rel?.tag ? { label: '태그', state: 'done', text: rel.tag.name, url: rel.tag.url }
      : { label: '태그', state: 'todo', text: checking ? '확인 중' : '-' },
    rel?.deploy ? { label: '배포', ...rel.deploy } : { label: '배포', state: 'todo', text: checking ? '확인 중' : '-' },
  ]
}

// 태그는 버전 순(v0.9 < v0.10). 정식 태그가 main에 차례로 붙는다는 전제라 "포함"이 단조롭다 → 이진 탐색
export const byVersion = (a: Tag, b: Tag) => a.name.localeCompare(b.name, undefined, { numeric: true })
export async function firstContaining<T>(sorted: T[], has: (t: T) => Promise<boolean>): Promise<T | undefined> {
  if (!sorted.length || !(await has(sorted[sorted.length - 1]))) return undefined
  let lo = 0, hi = sorted.length - 1 // hi는 항상 포함
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (await has(sorted[mid])) hi = mid
    else lo = mid + 1
  }
  return sorted[lo]
}

// 커밋 sha가 태그 커밋에 들어 있나. 두 sha가 같으면 답이 바뀌지 않아서 이 PC에 기억해 둔다 (태그가 옮겨지면 sha가 달라짐)
async function contains(repo: string, sha: string, tagSha: string): Promise<boolean> {
  const key = `gto:in:${tagSha.slice(0, 12)}:${sha.slice(0, 12)}`
  try { const v = localStorage.getItem(key); if (v) return v === '1' } catch { /* 기억 못 하면 매번 확인 */ }
  let yes: boolean
  try {
    yes = ['ahead', 'identical'].includes((await gh(`repos/${repo}/compare/${sha}...${tagSha}?per_page=1`)).status)
  } catch (e: any) {
    if (e.status !== 404) throw e
    yes = false // 커밋이 없어짐 (브랜치 삭제, squash 머지 등)
  }
  try { localStorage.setItem(key, yes ? '1' : '0') } catch { /* 위와 같음 */ }
  return yes
}

// 레포마다 태그, 릴리스를 한 번 읽고 이슈별로 판단. 결과는 카드 id("owner/repo#12") → Release
export async function loadReleases(issues: Issue[]): Promise<Map<string, Release>> {
  const out = new Map<string, Release>()
  const repos = [...new Set(issues.filter((i) => i.commits.length).map((i) => i.repo))]
  await Promise.all(repos.map(async (repo) => {
    const [tags, releases] = await Promise.all([
      ghAll(`repos/${repo}/tags`).then((ts) => ts.map((t: any): Tag => ({ name: t.name, sha: t.commit.sha }))),
      ghAll(`repos/${repo}/releases`),
    ])
    const pre = new Set(releases.filter((r: any) => r.prerelease).map((r: any) => r.tag_name))
    const devTags = tags.filter((t: Tag) => pre.has(t.name))
    const relTags = tags.filter((t: Tag) => !pre.has(t.name)).sort(byVersion)
    const tagUrl = (name: string) => releases.find((r: any) => r.tag_name === name)?.html_url ?? `https://github.com/${repo}/tree/${name}`
    const runs = new Map<string, Promise<Release['deploy']>>() // 태그별 빌드 상태 (여러 이슈가 같은 태그)

    const mine = issues.filter((x) => x.repo === repo && x.commits.length)
    // 처음 한 번만 API를 많이 쓰고 이후는 기억한 값. 한도를 한꺼번에 쓰지 않게 6개씩
    for (let k = 0; k < mine.length; k += 6) await Promise.all(mine.slice(k, k + 6).map(async (i) => {
      const sha = i.commits[i.commits.length - 1]
      const dev = await firstContaining(devTags, (t) => contains(repo, sha, t.sha))
      const tag = await firstContaining(relTags, (t) => contains(repo, sha, t.sha))
      let deploy: Release['deploy']
      if (tag) {
        if (!runs.has(tag.name)) runs.set(tag.name, deployOf(repo, tag.name, releases))
        deploy = await runs.get(tag.name)
      }
      out.set(`${repo}#${i.number}`, {
        dev: dev && { name: dev.name, url: tagUrl(dev.name) },
        tag: tag && { name: tag.name, url: tagUrl(tag.name) },
        deploy,
      })
    }))
  }))
  return out
}

// 정식 릴리스가 있으면 배포 완료. 없으면 그 태그로 돈 워크플로 상태
async function deployOf(repo: string, tag: string, releases: any[]): Promise<Release['deploy']> {
  const r = releases.find((x) => x.tag_name === tag && !x.draft && !x.prerelease)
  if (r) return { state: 'done', text: '릴리스', url: r.html_url }
  const run = (await gh(`repos/${repo}/actions/runs?branch=${encodeURIComponent(tag)}&per_page=1`)).workflow_runs?.[0]
  if (!run) return { state: 'todo', text: '빌드 없음' }
  if (run.status !== 'completed') return { state: 'active', text: '빌드 중', url: run.html_url }
  return run.conclusion === 'success'
    ? { state: 'done', text: '빌드 성공', url: run.html_url }
    : { state: 'fail', text: `빌드 ${run.conclusion}`, url: run.html_url }
}

// ── 배포 탭: 레포별 최근 릴리스·태그와 빌드 상태 ──
export type DeployRow = {
  repo: string; name: string; prerelease: boolean; released: boolean // released = GitHub 릴리스가 있음
  date?: string; url: string; assets: { name: string; url: string; size: number }[]
  build: { state: StageState; text: string; url?: string }
}

// 태그 커밋에서 돈 빌드 워크플로 (태그 push든 develop-ci든 같은 커밋). gto 동기화(gto.yml)는 빌드가 아니라서 뺀다
async function buildOf(repo: string, sha: string): Promise<{ run?: any; build: DeployRow['build'] }> {
  const runs = (await gh(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`)).workflow_runs ?? []
  const run = runs.find((r: any) => !/\/gto\.ya?ml$/.test(r.path))
  if (!run) return { build: { state: 'todo', text: '빌드 기록 없음' } }
  const build: DeployRow['build'] = run.status !== 'completed' ? { state: 'active', text: '빌드 중', url: run.html_url }
    : run.conclusion === 'success' ? { state: 'done', text: '빌드 성공', url: run.html_url }
    : { state: 'fail', text: `빌드 ${run.conclusion}`, url: run.html_url }
  return { run, build }
}

// 프리릴리스(develop-latest 등) 전부 + 정식 태그 최근 limit개, 최신이 위
export async function loadDeploys(repos: string[], limit = 8): Promise<DeployRow[]> {
  const perRepo = await Promise.all(repos.map(async (repo) => {
    const [tags, releases] = await Promise.all([
      ghAll(`repos/${repo}/tags`).then((ts) => ts.map((t: any): Tag => ({ name: t.name, sha: t.commit.sha }))),
      ghAll(`repos/${repo}/releases`),
    ])
    const pre = new Set(releases.filter((r: any) => r.prerelease).map((r: any) => r.tag_name))
    const picked = [...tags.filter((t: Tag) => pre.has(t.name)), ...tags.filter((t: Tag) => !pre.has(t.name)).sort(byVersion).reverse().slice(0, limit)]
    return Promise.all(picked.map(async (t): Promise<DeployRow> => {
      const r = releases.find((x: any) => x.tag_name === t.name && !x.draft)
      const { run, build } = await buildOf(repo, t.sha)
      return {
        repo, name: t.name, prerelease: pre.has(t.name), released: !!r,
        date: r?.published_at ?? run?.created_at, url: r?.html_url ?? `https://github.com/${repo}/tree/${t.name}`,
        assets: (r?.assets ?? []).map((a: any) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
        // 릴리스가 있으면 배포는 끝난 것 (빌드 기록이 지워졌거나 수동 릴리스여도)
        build: r && build.state !== 'active' && build.state !== 'fail' ? { ...build, state: 'done', text: build.state === 'done' ? build.text : '릴리스됨' } : build,
      }
    }))
  }))
  return perRepo.flat()
}
