// 보드에서 여는 창: 이슈 만들기(모달), Jira 미리보기와 하위 작업(오른쪽 패널)
import { useEffect, useState, type MouseEvent } from 'react'
import { CheckCircle2, ExternalLink, Loader2, Plus, RotateCcw, X } from 'lucide-react'
import {
  createIssue, createSubIssue, importEpic, jiraKeyOfIssue, loadJiraEpics, loadJiraIssue, setIssueState, subIssues,
  type Epic, type Issue, type JiraEpic, type JiraInfo, type JiraIssue, type Profile,
} from './github'

// Jira에 이미 있는 (끝나지 않은) 에픽을 골라 마일스톤으로 가져온다
export function ImportEpicsDialog({ profile, onClose, onDone }: { profile: Profile; onClose: () => void; onDone: () => void }) {
  const [epics, setEpics] = useState<JiraEpic[]>()
  const [picked, setPicked] = useState(new Set<string>())
  const [log, setLog] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    window.gto.jiraConfigured().then(async (ok) => {
      if (!ok) return setErr('Jira 토큰을 먼저 설정하세요 (설정 화면).')
      const list = await loadJiraEpics(profile)
      setEpics(list)
      setPicked(new Set(list.filter((e) => !e.linked).map((e) => e.key)))
    }).catch((e) => setErr(String(e)))
  }, [profile])

  const run = async () => {
    setRunning(true)
    for (const epic of (epics ?? []).filter((e) => picked.has(e.key))) {
      try {
        const r = await importEpic(profile, epic)
        setLog((l) => [...l, `✔ ${epic.key} ${epic.summary} → 마일스톤` +
          (r.assigned.length ? ` · 이슈 ${r.assigned.join(' ')}에 지정` : '') +
          (r.skipped.length ? ` · 건너뜀 ${r.skipped.join(' ')}` : '')])
      } catch (e) {
        setLog((l) => [...l, `✘ ${epic.key} ${epic.summary}: ${e}`])
      }
    }
    setRunning(false)
    onDone()
  }

  const toggle = (key: string) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>Jira 에픽 가져오기</h2>
          <span className="grow" />
          <button className="icon ghost" onClick={onClose} disabled={running}><X /></button>
        </div>
        <p className="desc" style={{ margin: '0 0 12px', color: 'var(--muted-foreground)', fontSize: 12.5 }}>
          끝나지 않은 에픽을 프로필의 모든 레포에 같은 이름의 마일스톤으로 만들고 기존 에픽에 연결합니다(새 에픽을 만들지 않음).
          에픽에 속한 작업의 GitHub 이슈에도 마일스톤을 지정합니다. 한 번만 하면 되고, 이후로는 GitHub → Jira로만 동기화됩니다.
        </p>
        {err && <div className="banner" style={{ margin: '0 0 12px' }}>{err}</div>}
        {!epics && !err && <p className="muted"><Loader2 className="spin" size={14} /> Jira에서 읽는 중…</p>}
        {epics && !epics.length && <p className="muted">끝나지 않은 에픽이 없습니다.</p>}
        {epics?.map((e) => (
          <label key={e.key} className="pick">
            <input type="checkbox" checked={picked.has(e.key)} disabled={e.linked || running} onChange={() => toggle(e.key)} />
            <code>{e.key}</code>
            <span className="grow">{e.summary}</span>
            {e.linked ? <span className="badge done">연결됨</span> : <span className={`badge ${e.category}`}>{e.status}</span>}
          </label>
        ))}
        {log.length > 0 && <pre className="import-log">{log.join('\n')}</pre>}
        <div className="modal-foot">
          <button onClick={onClose} disabled={running}>닫기</button>
          <button className="primary" onClick={run} disabled={running || !picked.size || log.length > 0}>
            {running ? <><Loader2 className="spin" />가져오는 중…</> : `${picked.size}개 가져오기`}
          </button>
        </div>
      </div>
    </div>
  )
}

// parent가 있으면 그 이슈의 하위 작업 (레포, 마일스톤은 상위를 따름)
export function NewIssueDialog({ profile, epics, epic, parent, onClose, onCreated }: {
  profile: Profile; epics: Epic[]; epic?: Epic; parent?: Issue; onClose: () => void; onCreated: () => void
}) {
  const [repo, setRepo] = useState(profile.repos[0])
  const [epicKey, setEpicKey] = useState(epic?.key ?? '')
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [content, setContent] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!title.trim()) return setErr('제목을 입력하세요')
    setSaving(true)
    try {
      if (parent) await createSubIssue(profile, parent, { title: title.trim(), assignee, content })
      else await createIssue(profile, { repo, title: title.trim(), assignee, content, epic: epics.find((e) => e.key === epicKey) })
      onCreated()
    } catch (e) {
      setErr(String(e))
      setSaving(false)
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={(e) => { e.preventDefault(); submit() }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-head">
          <h2>{parent ? '새 하위 작업' : '새 이슈'}</h2>
          <span className="grow" />
          <button type="button" className="icon ghost" onClick={onClose}><X /></button>
        </div>
        <div className="fields">
          {parent && <p className="desc">상위: #{parent.number} {parent.title}</p>}
          {!parent && profile.repos.length > 1 && (
            <label>레포
              <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                {profile.repos.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
          )}
          <label>제목
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="무엇을 하나요?" />
          </label>
          <div className={parent ? '' : 'two'}>
            {!parent && <label>마일스톤 (에픽)
              <select value={epicKey} onChange={(e) => setEpicKey(e.target.value)}>
                <option value="">없음</option>
                {epics.map((e) => <option key={e.key} value={e.key}>{e.title}</option>)}
              </select>
            </label>}
            <label>담당자
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">없음</option>
                {Object.keys(profile.assignees ?? {}).map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <label>내용
            <textarea rows={7} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Markdown 사용 가능" />
          </label>
          <p className="desc">"{profile.label}" 라벨이 붙어 Jira {parent ? '하위 작업' : '일감'}으로 동기화됩니다.</p>
        </div>
        {err && <div className="banner" style={{ margin: '0 0 12px' }}>{err}</div>}
        <div className="modal-foot">
          <button type="button" onClick={onClose}>취소</button>
          <button className="primary" disabled={saving}>{saving ? '만드는 중…' : parent ? '하위 작업 만들기' : '이슈 만들기'}</button>
        </div>
      </form>
    </div>
  )
}

// GitHub 이슈가 Jira에서 어떻게 보이는지. 키는 GitHub 코멘트에서 찾고, 내용은 Jira 토큰이 있을 때 읽는다.
export function JiraPanel({ profile, issue, knownKey, onClose }: {
  profile: Profile; issue: Issue; knownKey?: string; onClose: () => void
}) {
  const [key, setKey] = useState<string | null | undefined>(knownKey)
  const [data, setData] = useState<JiraIssue>()
  const [note, setNote] = useState('')

  useEffect(() => {
    let alive = true
    setData(undefined)
    setNote('')
    ;(async () => {
      const k = knownKey ?? await jiraKeyOfIssue(issue)
      if (!alive) return
      setKey(k)
      if (!k) return
      if (!(await window.gto.jiraConfigured())) return setNote('Jira 토큰을 설정하면 여기서 바로 볼 수 있습니다 (설정 화면).')
      const d = await loadJiraIssue(profile, k)
      if (alive) setData(d)
    })().catch((e) => alive && setNote(String(e)))
    return () => { alive = false }
  }, [issue, knownKey])

  const browse = key && `${profile.jira.baseUrl}/browse/${key}`
  const f = data?.fields
  // 설명 안의 링크는 앱 창이 아니라 브라우저로
  const openLinks = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    window.open(a.href, '_blank')
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="badge">Jira</span>
        <h2>{key ?? '…'}</h2>
        <span className="grow" />
        {browse && <a className="btn" href={browse} target="_blank"><ExternalLink />Jira에서 열기</a>}
        <button className="icon ghost" onClick={onClose}><X /></button>
      </div>
      <div className="drawer-body">
        {key === undefined && <p className="muted"><Loader2 className="spin" size={14} /> 찾는 중…</p>}
        {key === null && (
          <p className="muted">아직 Jira 일감과 연결되지 않은 이슈입니다. "{profile.label}" 라벨이 있으면 동기화가 돌 때 만들어집니다.</p>
        )}
        {note && <p className="muted">{note}</p>}
        {key && !data && !note && <p className="muted"><Loader2 className="spin" size={14} /> Jira에서 읽는 중…</p>}
        {f && (
          <>
            <h3 className="jira-title">{f.summary}</h3>
            <dl className="props">
              <dt>상태</dt><dd><span className={`badge ${f.status.statusCategory.key}`}>{f.status.name}</span></dd>
              <dt>유형</dt><dd>{f.issuetype.name}</dd>
              <dt>담당자</dt><dd>{f.assignee?.displayName ?? <span className="muted">없음</span>}</dd>
              <dt>상위 에픽</dt><dd>{f.parent ? `${f.parent.key} ${f.parent.fields.summary}` : <span className="muted">없음</span>}</dd>
              <dt>우선순위</dt><dd>{f.priority?.name ?? '-'}</dd>
              <dt>기한</dt><dd>{f.duedate ?? <span className="muted">없음</span>}</dd>
              <dt>보고자</dt><dd>{f.reporter?.displayName ?? '-'}</dd>
              <dt>수정</dt><dd className="muted">{new Date(f.updated).toLocaleString()}</dd>
            </dl>
            <div className="section-label" style={{ padding: '16px 0 6px' }}>설명</div>
            {/* Jira가 렌더링한 HTML. CSP(script-src 'self')로 스크립트는 실행되지 않는다 */}
            <div className="jira-desc" onClick={openLinks}
              dangerouslySetInnerHTML={{ __html: data.renderedFields.description ?? '<p class="muted">설명 없음</p>' }} />
          </>
        )}
      </div>
    </aside>
  )
}

// 하위 작업 목록. 보드를 다시 읽을 때(version)마다 GitHub에서 새로 읽는다
export function SubIssuesPanel({ issue, jira, version, onCreate, onChanged, onClose }: {
  issue: Issue; jira: Map<string, JiraInfo>; version: number; onCreate: () => void; onChanged: () => void; onClose: () => void
}) {
  const [subs, setSubs] = useState<Issue[]>()
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    subIssues(issue).then((s) => alive && setSubs(s), (e) => alive && setErr(String(e)))
    return () => { alive = false }
  }, [issue, version])

  const toggle = (s: Issue) => {
    const state = s.state === 'open' ? 'closed' : 'open'
    setSubs((all) => all?.map((x) => (x === s ? { ...x, state } : x)))
    setIssueState(s, state).then(onChanged, (e) => setErr(String(e)))
  }
  const done = subs?.filter((s) => s.state === 'closed').length ?? 0

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <span className="badge">하위 작업</span>
        <h2>#{issue.number}</h2>
        <span className="grow" />
        <button className="primary" onClick={onCreate}><Plus />만들기</button>
        <button className="icon ghost" onClick={onClose}><X /></button>
      </div>
      <div className="drawer-body">
        <h3 className="jira-title">{issue.title}</h3>
        {err && <div className="banner" style={{ margin: '0 0 12px' }}>{err}</div>}
        {!subs && !err && <p className="muted"><Loader2 className="spin" size={14} /> 읽는 중…</p>}
        {subs && !subs.length && <p className="muted">하위 작업이 없습니다.</p>}
        {subs && subs.length > 0 && <p className="muted">완료 {done} / {subs.length}</p>}
        {subs?.map((s) => {
          const j = jira.get(`${s.repo}#${s.number}`)
          return (
            <div key={s.id} className={`sub-row ${s.state}`}>
              <button className="icon ghost" onClick={() => toggle(s)} title={s.state === 'open' ? '닫기 (완료)' : '다시 열기'}>
                {s.state === 'open' ? <CheckCircle2 /> : <RotateCcw />}
              </button>
              <span className="grow">
                <a href={s.url} target="_blank">{s.title}</a>
                <span className="card-meta">
                  <span className="repo">#{s.number}</span>
                  {s.assignee && <span className="assignee">{s.assignee}</span>}
                  {s.state === 'closed' && <span className="badge done">완료</span>}
                  {j && <span className={`badge ${j.category}`}>{j.key} {j.status}</span>}
                </span>
              </span>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
