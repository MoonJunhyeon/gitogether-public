// F6: 프로필 레포의 Actions 실행 이력, 로그, 수동 실행/재실행, 워크플로 YAML 편집, Secrets 등록
import { useEffect, useState } from 'react'
import { CheckCircle2, CircleSlash, ExternalLink, FileCode2, KeyRound, Loader2, MinusCircle, Play, Plus, RefreshCw, RotateCw, ScrollText, XCircle } from 'lucide-react'
import { getFile, gh, putFile, type Profile } from './github'

type Run = {
  id: number; name: string; display_title: string; status: string; conclusion: string | null
  event: string; head_branch: string; created_at: string; html_url: string
}
type Workflow = { id: number; name: string; path: string }
type Editing = { path: string; text: string; sha?: string }

function RunState({ run }: { run: Run }) {
  if (run.status !== 'completed') return <span className="run-state running"><Loader2 className="spin" />{run.status}</span>
  const icon = { success: <CheckCircle2 />, failure: <XCircle />, cancelled: <CircleSlash />, skipped: <MinusCircle /> }[run.conclusion ?? '']
  return <span className={`run-state ${run.conclusion}`}>{icon ?? <MinusCircle />}{run.conclusion}</span>
}

export default function Actions({ profile }: { profile: Profile }) {
  const [repo, setRepo] = useState(profile.repos[0])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [secrets, setSecrets] = useState<string[] | null>(null) // null = 볼 권한 없음
  const [log, setLog] = useState<{ run: Run; text: string }>()
  const [editing, setEditing] = useState<Editing>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => setRepo(profile.repos[0]), [profile])

  const load = () => {
    setError('')
    Promise.all([
      gh(`repos/${repo}/actions/workflows?per_page=100`).then((r) => setWorkflows(r.workflows)),
      gh(`repos/${repo}/actions/runs?per_page=30`).then((r) => setRuns(r.workflow_runs)),
      gh(`repos/${repo}/actions/secrets?per_page=100`)
        .then((r) => setSecrets(r.secrets.map((s: { name: string }) => s.name)), () => setSecrets(null)),
    ]).catch((e) => setError(String(e)))
  }
  useEffect(load, [repo])

  const act = (f: () => Promise<unknown>, done: string) => {
    setError('')
    setNotice('')
    return f().then(() => { setNotice(done); load() }, (e) => setError(String(e)))
  }

  const showLog = async (run: Run) => {
    setLog({ run, text: '불러오는 중...' })
    try {
      const { jobs } = await gh(`repos/${repo}/actions/runs/${run.id}/jobs`)
      const parts = await Promise.all(jobs.map(async (j: { id: number; name: string; status: string; conclusion: string | null }) =>
        `===== ${j.name} (${j.conclusion ?? j.status}) =====\n` +
        (j.conclusion === 'skipped' ? '(건너뜀, 로그 없음)'
          : j.status === 'completed' ? await window.gto.jobLog(repo, j.id).catch(String) : '(아직 실행 중)')))
      setLog({ run, text: parts.join('\n\n') || '(잡 없음)' })
    } catch (e) {
      setLog({ run, text: String(e) })
    }
  }

  const dispatch = (w: Workflow) => act(async () => {
    const { default_branch } = await gh(`repos/${repo}`)
    await gh(`repos/${repo}/actions/workflows/${w.id}/dispatches`, 'POST', { ref: default_branch })
  }, `${w.name} 실행을 요청했습니다. 목록에 뜨기까지 몇 초 걸릴 수 있습니다.`)

  const edit = (path: string) =>
    getFile(repo, path).then((f) => setEditing({ path, ...f }), (e) => setError(String(e)))

  if (editing) {
    return <YamlEditor repo={repo} value={editing} onClose={(saved) => { setEditing(undefined); if (saved) { setNotice(`${saved} 커밋했습니다.`); load() } }} />
  }

  if (log) {
    return (
      <div className="editor">
        <div className="bar">
          <RunState run={log.run} />
          <h2>{log.run.name} · {log.run.display_title}</h2>
          <span className="grow" />
          <a className="btn" href={log.run.html_url} target="_blank"><ExternalLink />GitHub</a>
          {log.run.status === 'completed' && (
            <button onClick={() => act(() => gh(`repos/${repo}/actions/runs/${log.run.id}/rerun`, 'POST'), '재실행을 요청했습니다.').then(() => setLog(undefined))}><RotateCw />재실행</button>
          )}
          <button className="primary" onClick={() => setLog(undefined)}>닫기</button>
        </div>
        <pre>{log.text}</pre>
      </div>
    )
  }

  return (
    <>
      {error && <div className="banner">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <div className="actions-view">
        <div className="actions-side">
          <section className="panel">
            <div className="row">
              <select className="grow" value={repo} onChange={(e) => setRepo(e.target.value)}>
                {profile.repos.map((r) => <option key={r}>{r}</option>)}
              </select>
              <button className="icon" onClick={load} title="새로고침"><RefreshCw /></button>
            </div>
          </section>
          <section className="panel">
            <h2><FileCode2 />워크플로</h2>
            {workflows.map((w) => (
              <div key={w.id} className="list-row">
                <span className="name">{w.name}<small>{w.path}</small></span>
                <button className="link" onClick={() => dispatch(w)} title="실행 (workflow_dispatch 트리거가 있어야 함)"><Play size={13} /></button>
                <button className="link" onClick={() => edit(w.path)}>편집</button>
              </div>
            ))}
            <button style={{ marginTop: 8 }} onClick={() => setEditing({ path: '.github/workflows/new.yml', text: '' })}><Plus />새 워크플로</button>
          </section>
          <section className="panel">
            <h2><KeyRound />Secrets</h2>
            {secrets === null ? <p className="desc">목록을 볼 권한이 없습니다 (등록은 가능할 수 있음)</p>
              : secrets.map((s) => <div key={s} className="list-row"><code className="name">{s}</code></div>)}
            <SecretForm onSave={(name, value) => act(() => window.gto.putSecret(repo, name, value), `${name} Secret을 등록했습니다.`)} />
          </section>
        </div>
        <div className="runs-wrap">
          <table className="runs">
            <thead><tr><th>상태</th><th>워크플로</th><th>내용</th><th>이벤트</th><th>브랜치</th><th>시작</th><th /></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><RunState run={r} /></td>
                  <td>{r.name}</td>
                  <td className="title">{r.display_title}</td>
                  <td><span className="badge">{r.event}</span></td>
                  <td className="muted">{r.head_branch}</td>
                  <td className="muted">{new Date(r.created_at).toLocaleString()}</td>
                  <td>
                    <button className="link" onClick={() => showLog(r)}><ScrollText size={13} />로그</button>
                    {r.status === 'completed' && (
                      <button className="link" onClick={() => act(() => gh(`repos/${repo}/actions/runs/${r.id}/rerun`, 'POST'), '재실행을 요청했습니다.')}><RotateCw size={13} />재실행</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function YamlEditor({ repo, value, onClose }: { repo: string; value: Editing; onClose: (saved?: string) => void }) {
  const [path, setPath] = useState(value.path)
  const [text, setText] = useState(value.text)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(path)) return setErr('경로는 .github/workflows/이름.yml 이어야 합니다')
    setSaving(true)
    try {
      await putFile(repo, path, text, value.sha, `workflow: ${path}`)
      onClose(path)
    } catch (e) {
      // 403/404: 토큰에 workflow 권한(fine-grained: Workflows write)이 없거나, 브랜치 보호로 직접 커밋이 막힘
      setErr(String(e))
      setSaving(false)
    }
  }

  return (
    <div className="editor">
      <div className="bar">
        <h2>{repo}</h2>
        <input value={path} onChange={(e) => setPath(e.target.value)} disabled={!!value.sha} size={40} />
        <span className="grow" />
        <button onClick={() => onClose()}>취소</button>
        <button className="primary" onClick={save} disabled={saving}>저장 (기본 브랜치에 커밋)</button>
      </div>
      {err && <div className="banner">{err}</div>}
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </div>
  )
}

function SecretForm({ onSave }: { onSave: (name: string, value: string) => Promise<unknown> }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  return (
    <form className="secret-form" onSubmit={(e) => {
      e.preventDefault()
      if (name && value) onSave(name.trim(), value).then(() => setValue(''))
    }}>
      <input placeholder="이름 (예: ANTHROPIC_API_KEY)" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="값" type="password" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="primary">등록/변경</button>
    </form>
  )
}
