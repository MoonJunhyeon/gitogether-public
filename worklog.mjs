// F3: push된 커밋이 참조한 GitHub 이슈마다, 아직 기록 안 된 커밋 목록을 이슈 본문의 "작업 내용" 칸에 날짜별로 덧붙인다.
// LLM은 쓰지 않는다. 요약은 앱("작업 요약" 버튼)이 이 커밋 목록을 읽어 같은 칸의 요약 자리(gto:summary)에 쓴다.
// 브랜치는 가리지 않는다: 모든 브랜치의 push를 받아 커밋 메시지의 #이슈번호로 이슈를 찾고, 이슈 타임라인의 커밋 참조도 더한다
// (타임라인은 한 번에 많이 push된 커밋을 빠뜨리므로 보조로만). 이미 기록한 커밋(본문에 숨겨 둔 SHA 목록)은 건너뛰어서
// 같은 커밋이 기능 브랜치 → develop → main 으로 와도 한 번만 기록된다.
// Jira로는 sync(F1)가 이슈 본문을 그대로 옮긴다. Actions 토큰으로 고친 이슈는 이벤트가 다시 생기지 않아서 여기서 바로 호출한다.
// 커밋 규칙 "type(#이슈번호) : 내용"의 #0(이슈 없음)은 기록하지 않는다.
import { readFileSync } from 'node:fs'
import { env, gh, issueRefs, p } from './lib.mjs'
import { syncIssue } from './sync.mjs'

// 이슈 본문의 작업 내용 칸. 앱(app/src/renderer/src/github.ts)도 같은 표시를 쓴다.
const START = '<!-- gto:worklog -->'
const END = '<!-- /gto:worklog -->'
const SHAS_RE = /<!-- gto:shas ([0-9a-f ]*) -->/

// 이슈 본문에서 이미 기록한 커밋 SHA(앞 12자리) 목록
export const loggedShas = (body) => (body ?? '').match(SHAS_RE)?.[1].split(' ').filter(Boolean) ?? []

// 본문의 작업 내용 칸에 항목을 덧붙이고 기록한 SHA를 남긴다. 칸이 없으면 본문 끝에 만든다. 칸 밖의 내용과 요약은 그대로 둔다.
export function appendLog(body, entry, shas) {
  body = (body ?? '').replace(/\r/g, '')
  const all = [...new Set([...loggedShas(body), ...shas.map((s) => s.slice(0, 12))])]
  const shasLine = `<!-- gto:shas ${all.join(' ')} -->`
  const s = body.indexOf(START)
  const e = body.indexOf(END)
  if (s < 0 || e < s) {
    return `${body.trimEnd()}\n\n${START}\n## 작업 내용\n${shasLine}\n${entry ? `\n${entry}\n` : ''}${END}\n`.trimStart()
  }
  const section = body.slice(s, e).replace(SHAS_RE, shasLine)
  return body.slice(0, s) + section.trimEnd() + (entry ? `\n\n${entry}` : '') + '\n' + body.slice(e)
}

// 이 이슈를 참조한 커밋 전부 (브랜치 무관)
async function referencedCommits(n) {
  const out = []
  for (let page = 1; ; page++) {
    const batch = await gh('GET', `issues/${n}/timeline?per_page=100&page=${page}`)
    out.push(...batch.filter((e) => e.event === 'referenced' && e.commit_id).map((e) => e.commit_id))
    if (batch.length < 100) return [...new Set(out)]
  }
}

async function updateIssue(n, pushedShas) {
  const issue = await gh('GET', `issues/${n}`)
  if (issue.pull_request || !issue.labels.some((l) => l.name === p.label)) return
  const done = loggedShas(issue.body)
  const candidates = [...new Set([...pushedShas, ...(await referencedCommits(n))])]
  const todo = candidates.filter((sha) => !done.some((d) => sha.startsWith(d)))
  if (!todo.length) return

  const work = []
  for (const sha of todo) {
    const c = await gh('GET', `commits/${sha}`).catch(() => null) // 포크 등 이 레포에서 못 읽는 커밋
    if (!c || c.parents.length > 1) continue // 머지 커밋: 실제 작업은 합쳐진 커밋들에 있음
    // PR 머지로 새로 생긴 커밋(squash 등)은 원래 커밋들을 이미 기록했으므로 건너뜀
    // ponytail: rebase 머지는 커밋이 전부 새 SHA라 한 번 더 기록될 수 있음, 쓰게 되면 PR 단위로 묶기
    const prs = await gh('GET', `commits/${sha}/pulls`)
    if (prs.some((pr) => pr.merge_commit_sha === sha)) continue
    if (issueRefs(c.commit.message).includes(n)) work.push(c)
  }
  if (!work.length) return // 머지 커밋뿐: 기록할 작업 없음
  work.sort((a, b) => a.commit.committer.date.localeCompare(b.commit.committer.date))

  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
  const lines = work.map((c) => `- ${c.commit.message.split('\n')[0]} ([${c.sha.slice(0, 7)}](${c.html_url}))`)
  const entry = `### ${date}\n${lines.join('\n')}`

  // 커밋을 읽는 사이 누가 본문을 고쳤을 수 있으니 다시 읽어서 그 위에 덧붙인다
  // ponytail: 같은 이슈를 두 push가 동시에 고치면 드물게 한쪽 항목이 빠질 수 있음 (다음 push 때 남은 커밋은 다시 기록됨)
  const latest = await gh('GET', `issues/${n}`)
  const updated = await gh('PATCH', `issues/${n}`, { body: appendLog(latest.body, entry, todo) })
  console.log(`#${n}: 커밋 ${todo.length}개 확인, ${work.length}개 기록\n${entry}`)
  await syncIssue(updated, 'edited')
}

if (env.GITHUB_EVENT_NAME === 'push') {
  const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  if (!p) console.log('::notice::프로필 없음, 건너뜀')
  else if (!ev.deleted) {
    // 이번 push로 들어온 커밋 (push 이벤트에는 20개까지만 실려서 가능하면 compare로 전부)
    // ponytail: compare는 250개까지, 새 브랜치 첫 push는 이벤트의 20개까지만 봄
    let pushed = ev.commits.map((c) => ({ sha: c.id, message: c.message }))
    if (!/^0+$/.test(ev.before)) {
      pushed = await gh('GET', `compare/${ev.before}...${ev.after}?per_page=250`)
        .then((r) => r.commits.map((c) => ({ sha: c.sha, message: c.commit.message })), () => pushed) // force push 등으로 비교가 안 되면 이벤트 것만
    }
    const byIssue = new Map()
    for (const c of pushed) for (const n of issueRefs(c.message)) byIssue.set(n, [...(byIssue.get(n) ?? []), c.sha])
    // 이슈 하나가 실패해도 나머지는 기록한다 (실패는 경고로 남기고 실행은 실패 처리)
    let failed = 0
    for (const [n, shas] of byIssue) {
      await updateIssue(n, shas).catch((e) => { failed++; console.log(`::warning::#${n} 기록 실패: ${e.message}`) })
    }
    if (failed) process.exitCode = 1
  }
}
