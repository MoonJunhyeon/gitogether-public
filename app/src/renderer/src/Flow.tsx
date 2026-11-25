// 이슈부터 배포까지 한눈에: 흐름 탭 표와 오른쪽 상세 패널
import { ExternalLink, X } from 'lucide-react'
import type { Epic, Issue, JiraInfo } from './github'
import { STAGES, stagesOf, type DeployRow, type Release, type Stage } from './pipeline'

const STATE_TEXT = { done: '완료', active: '진행 중', fail: '실패', todo: '아직' }

const Cell = ({ s }: { s: Stage }) => (
  <span className={`fcell ${s.state}`}>
    <span className={`fdot ${s.state}`} />
    {s.url ? <a href={s.url} target="_blank">{s.text}</a> : <span>{s.text}</span>}
  </span>
)

// 오른쪽 패널: 단계별 세로 목록과 커밋
export function FlowPanel({ issue, jira, release, jiraBase, onClose }: {
  issue: Issue; jira?: JiraInfo; release?: Release; jiraBase: string; onClose: () => void
}) {
  const stages = stagesOf(issue, jira, release, jiraBase)
  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="badge">흐름</span>
        <h2>#{issue.number}</h2>
        <span className="grow" />
        <a className="btn" href={issue.url} target="_blank"><ExternalLink />GitHub</a>
        <button className="icon ghost" onClick={onClose}><X /></button>
      </div>
      <div className="drawer-body">
        <h3 className="jira-title">{issue.title}</h3>
        <ol className="flow-steps">
          {stages.map((s, i) => (
            <li key={i} className={s.state}>
              <span className={`fdot ${s.state}`} />
              <span className="flow-step-label">{i + 1}. {s.label}</span>
              <span className="grow">{s.url ? <a href={s.url} target="_blank">{s.text}</a> : s.text}</span>
              <span className="muted">{STATE_TEXT[s.state]}</span>
            </li>
          ))}
        </ol>
        {issue.commits.length > 0 && (
          <>
            <div className="section-label" style={{ padding: '16px 0 6px' }}>기록된 커밋</div>
            {issue.commits.map((sha) => (
              <div key={sha} className="sub-row">
                <a className="mono" href={`https://github.com/${issue.repo}/commit/${sha}`} target="_blank">{sha.slice(0, 7)}</a>
              </div>
            ))}
          </>
        )}
        <p className="muted" style={{ marginTop: 16 }}>
          개발 배포·태그는 마지막 커밋이 그 태그에 들어 있는지로 판단합니다. squash 머지로 sha가 바뀐 커밋은 잡히지 않습니다.
        </p>
      </div>
    </aside>
  )
}

// 흐름 탭: 에픽별로 이슈를 줄 세우고 단계를 열로
export function FlowTable({ epics, issues, jira, releases, jiraBase, onOpen }: {
  epics: Epic[]; issues: Issue[]; jira: Map<string, JiraInfo>; releases: Map<string, Release> | undefined
  jiraBase: string; onOpen: (i: Issue) => void
}) {
  const id = (i: Issue) => `${i.repo}#${i.number}`
  const groups = [
    ...epics.map((e) => ({ key: e.key, title: e.title, rows: issues.filter((i) => i.epic === e.key) })),
    { key: '', title: 'No milestone', rows: issues.filter((i) => !i.epic) },
  ].filter((g) => g.rows.length)
  if (!groups.length) return <div className="empty">보이는 이슈가 없습니다. 보드 필터를 확인하세요.</div>
  return (
    <div className="flow-table-wrap">
      <table className="flow-table">
        <thead>
          <tr><th>이슈</th>{STAGES.map((s, i) => <th key={s}>{i + 1}. {s}</th>)}</tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key}>
            <tr className="flow-epic"><th colSpan={STAGES.length + 1}>{g.title} <span className="count">{g.rows.length}</span></th></tr>
            {g.rows.map((i) => (
              <tr key={id(i)} onClick={(e) => { if (!(e.target as Element).closest('a')) onOpen(i) }} data-drawer-toggle>
                <td className="flow-issue">
                  <span className="repo">{i.repo.split('/')[1]}#{i.number}</span> {i.title}
                  {i.assignee && <span className="assignee">{i.assignee}</span>}
                </td>
                {stagesOf(i, jira.get(id(i)), releases?.get(id(i)), jiraBase).map((s, k) => <td key={k}><Cell s={s} /></td>)}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

const size = (b: number) => (b > 1 << 30 ? `${(b / (1 << 30)).toFixed(1)}GB` : b > 1 << 20 ? `${(b / (1 << 20)).toFixed(0)}MB` : `${Math.ceil(b / 1024)}KB`)

// 배포 탭: 레포별 릴리스 카드 (빌드 상태, 받을 파일, 들어간 이슈)
export function DeployList({ rows, issues, releases, error }: {
  rows?: DeployRow[]; issues: Issue[]; releases?: Map<string, Release>; error?: string
}) {
  if (error) return <div className="banner">{error}</div>
  if (!rows) return <p className="muted">릴리스와 빌드 상태를 읽는 중…</p>
  if (!rows.length) return <div className="empty">태그나 릴리스가 없습니다.</div>
  const id = (i: Issue) => `${i.repo}#${i.number}`
  // 정식 태그: 마지막 커밋이 처음 들어간 태그. 프리릴리스: 들어 있지만 아직 정식 태그 전 (= 다음 배포 대기)
  const inRow = (r: DeployRow) => issues.filter((i) => {
    if (i.repo !== r.repo) return false
    const rel = releases?.get(id(i))
    return r.prerelease ? rel?.dev?.name === r.name && !rel.tag : rel?.tag?.name === r.name
  })
  return (
    <div className="deploy-list">
      {rows.map((r) => {
        const its = inRow(r)
        return (
          <section key={`${r.repo}:${r.name}`} className="panel deploy-card">
            <div className="deploy-head">
              <span className={`fdot ${r.build.state}`} />
              <a className="deploy-name" href={r.url} target="_blank">{r.name}</a>
              <span className={r.prerelease ? 'badge indeterminate' : 'badge done'}>{r.prerelease ? '개발 배포' : '정식'}</span>
              <span className="muted">{r.repo.split('/')[1]}</span>
              <span className="grow" />
              {r.date && <span className="muted">{new Date(r.date).toLocaleString()}</span>}
              {r.build.url ? <a className={`fcell ${r.build.state}`} href={r.build.url} target="_blank">{r.build.text}</a>
                : <span className={`fcell ${r.build.state}`}>{r.build.text}</span>}
            </div>
            {r.assets.length > 0 && (
              <div className="deploy-assets">
                {r.assets.map((a) => <a key={a.name} className="badge" href={a.url} target="_blank" title="받기">{a.name} · {size(a.size)}</a>)}
              </div>
            )}
            <div className="deploy-issues">
              <span className="muted">{r.prerelease ? '정식 배포 대기 중인 이슈' : '이 버전에 처음 들어간 이슈'} {releases ? its.length : '…'}</span>
              {its.map((i) => (
                <a key={id(i)} href={i.url} target="_blank"><span className="repo">#{i.number}</span> {i.title}</a>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
