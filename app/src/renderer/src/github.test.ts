import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkProfile, norm } from './github.ts'

const ok = {
  name: 'X',
  jira: { baseUrl: 'https://a.atlassian.net', project: 'PRJ', types: { epic: '1', issue: '2' } },
  repos: ['acme/sample-app'],
  label: 'jira',
  mapping: { epic: 'milestone' },
  assignees: {},
}

test('checkProfile', () => {
  assert.equal(checkProfile(ok), null)
  assert.match(checkProfile({ ...ok, repos: ['no-slash'] })!, /repos/)
  assert.match(checkProfile({ ...ok, jira: { baseUrl: 'x' } })!, /jira/)
  assert.match(checkProfile({ ...ok, assignees: undefined })!, /assignees/)
  assert.match(checkProfile({ ...ok, mapping: { epic: 'projectField' } }, ok)!, /mapping\.epic/)
  assert.equal(checkProfile({ ...ok, label: 'x' }, ok), null)
})

test('norm matches sync.mjs', async () => {
  const sync = await import('../../../../lib.mjs')
  for (const s of ['  ABC-K   품질 개선 ', 'A\tB']) assert.equal(norm(s), sync.norm(s))
})

test('cardIdOfSummary', async () => {
  const { cardIdOfSummary } = await import('./github.ts')
  const repos = ['acme/sample-app', 'acme/sample-lib']
  assert.equal(cardIdOfSummary('[sample-lib#7] 제목', repos), 'acme/sample-lib#7')
  assert.equal(cardIdOfSummary('[other#7] 제목', repos), null)
  assert.equal(cardIdOfSummary('[GH-239] 옛 형식', repos), null)
  assert.equal(cardIdOfSummary('[GH-239] 옛 형식', repos.slice(0, 1)), 'acme/sample-app#239')
  assert.equal(cardIdOfSummary('그냥 제목', repos), null)
})

test('worklog summary (Actions가 만든 칸과 호환)', async () => {
  const { worklogCommits, setSummary, needsSummary } = await import('./github.ts')
  const { appendLog } = await import('../../../../worklog.mjs')
  const sha1 = 'b4d359aab4f97c6b257f0261c63ea33026d83c8b'
  const sha2 = '15c710ef72f58669af69b39ec4bda8a877f5bde5'
  let body = appendLog('### 내용\n\n원래 본문', `### 2026-10-19\n- feat(#212) : A ([b4d359a](https://github.com/o/r/commit/${sha1}))`, [sha1])
  assert.deepEqual(worklogCommits(body), [sha1])
  assert.equal(needsSummary(body), true)
  body = setSummary(body, '- 요약 1', '2026-10-19', [sha1])
  assert.equal(needsSummary(body), false)
  // 요약 뒤에 Actions가 커밋을 더 기록해도 요약은 그대로, 커밋은 아래에 쌓임
  body = appendLog(body, `### 2026-10-20\n- fix(#212) : B ([15c710e](https://github.com/o/r/commit/${sha2}))`, [sha2])
  assert.deepEqual(worklogCommits(body), [sha1, sha2])
  assert.equal(needsSummary(body), true) // 요약 뒤에 새 커밋
  body = setSummary(body, '- 요약 2', '2026-10-20', [sha1, sha2])
  assert.equal(needsSummary(body), false)
  assert.equal(needsSummary('칸 없음'), false)
  assert.ok(!body.includes('요약 1') && body.includes('- 요약 2'))
  assert.equal(body.match(/<!-- gto:summary -->/g)?.length, 1)
  assert.ok(body.indexOf('요약 2') < body.indexOf('feat(#212)')) // 요약은 커밋 목록 위
  assert.ok(body.startsWith('### 내용\n\n원래 본문'))
  assert.deepEqual(worklogCommits('칸 없음'), [])
})

test('보드에서 만든 이슈 본문을 동기화가 읽음', async () => {
  const { issueBody } = await import('./github.ts')
  const { formAssignee } = await import('../../../../lib.mjs')
  assert.equal(formAssignee(issueBody('홍길동', '할 일')), '홍길동')
  assert.equal(formAssignee(issueBody('', '할 일')), null)
  assert.equal(formAssignee(issueBody('', '')), null)
})

test('formAssignee는 lib.mjs와 같게', async () => {
  const app = await import('./github.ts')
  const lib = await import('../../../../lib.mjs')
  for (const b of ['### 담당자\r\n\r\n홍길동\r\n\r\n### 내용', '### 담당자\n\n_No response_', '### 담당자\n\n### 내용\n\nx', null, '내용만'])
    assert.equal(app.formAssignee(b), lib.formAssignee(b))
})

test('마일스톤 설명의 Jira 키 (sync.mjs 표시와 같게)', async () => {
  const { markerOf } = await import('./github.ts')
  const { MARKER_RE } = await import('../../../../lib.mjs')
  const desc = 'ABC-K 대상 품질 개선\n\n<!-- jira:PRJ-287 -->'
  assert.equal(markerOf(desc), 'PRJ-287')
  assert.equal(markerOf(desc), desc.match(MARKER_RE)?.[1])
  assert.equal(markerOf('표시 없음'), undefined)
  assert.equal(markerOf(null), undefined)
})

test('firstContaining: 버전 순 태그에서 커밋이 처음 들어간 태그', async () => {
  const { firstContaining, byVersion } = await import('./pipeline.ts')
  const tags = ['v0.10.0', 'v0.2.0', 'v0.9.0', 'v0.11.0'].map((name) => ({ name, sha: name })).sort(byVersion)
  assert.deepEqual(tags.map((t) => t.name), ['v0.2.0', 'v0.9.0', 'v0.10.0', 'v0.11.0'])
  for (let first = 0; first <= tags.length; first++) {
    const has = async (t: { name: string }) => tags.findIndex((x) => x.name === t.name) >= first
    assert.equal((await firstContaining(tags, has))?.name, tags[first]?.name)
  }
  assert.equal(await firstContaining([], async () => true), undefined)
})

test('stagesOf', async () => {
  const { stagesOf } = await import('./pipeline.ts')
  const issue = { repo: 'o/r', number: 1, url: 'u', state: 'open', commits: ['a'.repeat(40)] } as any
  assert.deepEqual(stagesOf(issue, undefined, undefined).map((s) => s.state), ['done', 'todo', 'done', 'todo', 'todo', 'todo'])
  assert.equal(stagesOf(issue, undefined, undefined)[4].text, '확인 중')
  const rel = { dev: { name: 'develop-latest', url: '' }, tag: { name: 'v1', url: '' }, deploy: { state: 'fail' as const, text: '빌드 failure' } }
  assert.deepEqual(stagesOf(issue, { key: 'PRJ-1', status: '진행', category: 'indeterminate' }, rel).map((s) => s.state), ['done', 'done', 'done', 'done', 'done', 'fail'])
})
