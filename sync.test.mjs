import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formAssignee, norm, COMMENT_RE, MARKER_RE } from './lib.mjs'

test('formAssignee', () => {
  assert.equal(formAssignee('### 담당자\r\n\r\n홍길동\r\n\r\n### 내용\r\n\r\nx'), '홍길동')
  assert.equal(formAssignee('### 담당자\n\n_No response_\n\n### 내용'), null)
  assert.equal(formAssignee('### 담당자\n\nNone\n\n### 내용'), null) // 선택 칸을 비운 경우
  assert.equal(formAssignee('### 담당자\n\n### 내용\n\nx'), null)
  assert.equal(formAssignee(null), null)
})

test('keys and names', () => {
  assert.equal('Jira: [PRJ-12](https://x/browse/PRJ-12)'.match(COMMENT_RE)[1], 'PRJ-12')
  assert.equal('설명\n<!-- jira:PRJ-3 -->'.match(MARKER_RE)[1], 'PRJ-3')
  assert.equal(norm('  ABC-K   품질 개선 '), norm('abc-k 품질 개선'))
})

test('issueRefs', async () => {
  const { issueRefs } = await import('./lib.mjs')
  assert.deepEqual(issueRefs('fix #12, #3 and #12; other/repo#9 abc#7'), [12, 3])
  assert.deepEqual(issueRefs(null), [])
  // 팀 커밋 규칙: type(#이슈번호) : 내용, 이슈 없으면 #0
  assert.deepEqual(issueRefs('feat(#226) : Easy Setup 진행중 표시 추가'), [226])
  assert.deepEqual(issueRefs('!HOTFIX(#17) : 긴급 수정'), [17])
  assert.deepEqual(issueRefs('fix(#0) : 쿼리 없는 DB Dataset 생성 허용'), [])
  assert.deepEqual(issueRefs("merge(#212) : Merge branch 'kafka-max-bytes' into develop"), [212])
})

test('worklog section', async () => {
  const { appendLog, loggedShas } = await import('./worklog.mjs')
  const form = '### 담당자\n\n홍길동\n\n### 내용\n\n원래 본문'
  const once = appendLog(form, '### 2026-10-19 · a\n- 첫 작업', ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'])
  assert.ok(once.startsWith(form))
  assert.deepEqual(loggedShas(once), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
  // 사람이 칸 앞 본문을 고친 뒤 두 번째 정리
  const edited = once.replace('원래 본문', '고친 본문')
  const twice = appendLog(edited, '### 2026-10-20 · c\n- 두 번째', ['cccccccccccccccc'])
  assert.ok(twice.includes('고친 본문') && twice.includes('- 첫 작업') && twice.includes('- 두 번째'))
  assert.ok(twice.indexOf('- 첫 작업') < twice.indexOf('- 두 번째'))
  assert.deepEqual(loggedShas(twice), ['aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'])
  assert.equal(twice.match(/<!-- gto:worklog -->/g).length, 1)
  // 정리할 작업은 없고(머지 커밋뿐) SHA만 기록
  assert.deepEqual(loggedShas(appendLog(twice, null, ['dddddddddddd'])).at(-1), 'dddddddddddd')
  assert.deepEqual(loggedShas(null), [])
})

test('toJira', async () => {
  const { toJira } = await import('./sync.mjs')
  assert.equal(
    toJira('### 담당자\r\n\r\n홍길동\n<!-- gto:worklog -->\n## 작업 내용\n<!-- gto:shas ab -->\n커밋: [b4d359a](https://github.com/o/r/commit/b4d) 끝'),
    'h3. 담당자\n\n홍길동\nh2. 작업 내용\n커밋: [b4d359a|https://github.com/o/r/commit/b4d] 끝')
  assert.equal(toJira('#212 이슈와 # 제목 아님'), '#212 이슈와 # 제목 아님') // 줄 맨앞의 "# "만 제목
})
