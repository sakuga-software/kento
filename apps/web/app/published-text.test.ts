// REV-127. No ticket id (`REV-12`) in what the bot posts on GitHub: the reviews, the comments, the
// description block, the check and the replies. The ids stay in the comments of the code.
//
// Two checks:
// - every string of the code that builds a text (the web service, the engine, the prompts that the
//   model reads and can echo) holds no id. A small scanner skips the comments of the code;
// - a review published on a fake GitHub, and the replies of the bot, hold no id.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as assert from 'remix/assert'
import { describe, it } from 'remix/test'

import { publishRichReview } from '../test/rich-review.ts'
import { hintText } from './commands/hint.ts'
import { feedbackEmptyText } from './feedback/handler.ts'
import { requestText } from './feedback/request.ts'
import { rejectProblemText, usage } from './github/comment-command.ts'
import { capSentence } from './org-settings/notice.ts'
import { failureComment } from './publish/failure.ts'

const TICKET_ID = /\bREV-\d+\b/
const SQL_COMMENT = /(?<=^|\s)-- [^\n]*/g
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/**
 * The strings of a TypeScript source: the text of each quote and of each template, without the
 * comments. A `/` opens a regular expression where a value starts, as in JavaScript.
 */
export function stringsOf(source: string): string[] {
  return scanSource(source).strings
}

/**
 * The strings of a source, and the rest of its code without the comments: the text of the JSX of
 * a screen is code, not a string.
 */
export function scanSource(source: string): { strings: string[]; code: string } {
  let out: string[] = []
  let code = ''
  // Each frame is a template, or the code of a `${}` with its open braces.
  let stack: ({ kind: 'template'; text: string } | { kind: 'code'; braces: number })[] = [{ kind: 'code', braces: 0 }]
  let previous = '' // The last character of code that is not a space: it tells a regex from a division.
  let i = 0
  let valueStart = () => previous === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous) || /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(source.slice(Math.max(0, i - 6), i).trimEnd())
  while (i < source.length) {
    let frame = stack[stack.length - 1]!
    let c = source[i]!
    if (frame.kind === 'template') {
      if (c === '\\') {
        frame.text += source.slice(i, i + 2)
        i += 2
      } else if (c === '`') {
        out.push(frame.text)
        stack.pop()
        previous = '`'
        i++
      } else if (c === '$' && source[i + 1] === '{') {
        out.push(frame.text)
        frame.text = ''
        stack.push({ kind: 'code', braces: 0 })
        previous = '{'
        i += 2
      } else {
        frame.text += c
        i++
      }
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i) === -1 ? source.length : source.indexOf('\n', i)
      code += ' '
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) === -1 ? source.length : source.indexOf('*/', i + 2) + 2
      code += ' '
    } else if (c === "'" || c === '"') {
      let end = i + 1
      let text = ''
      while (end < source.length && source[end] !== c && source[end] !== '\n') {
        if (source[end] === '\\') {
          text += source.slice(end, end + 2)
          end += 2
        } else text += source[end++]
      }
      out.push(text)
      previous = c
      i = end + 1
    } else if (c === '`') {
      stack.push({ kind: 'template', text: '' })
      i++
    } else if (c === '/' && valueStart()) {
      // A regular expression: its text counts too, a class `[...]` can hold a `/`.
      let end = i + 1
      let inClass = false
      while (end < source.length && source[end] !== '\n' && (inClass || source[end] !== '/')) {
        if (source[end] === '\\') end++
        else if (source[end] === '[') inClass = true
        else if (source[end] === ']') inClass = false
        end++
      }
      out.push(source.slice(i + 1, end))
      previous = '/'
      i = end + 1
    } else {
      if (c === '{') frame.braces++
      if (c === '}') {
        if (frame.braces === 0 && stack.length > 1) {
          stack.pop()
          i++
          continue
        }
        frame.braces--
      }
      if (!/\s/.test(c)) previous = c
      code += c
      i++
    }
  }
  return { strings: out, code }
}

function sources(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((file) => keep(file) && !file.includes('node_modules'))
}

describe('the scanner of the strings', () => {
  it('keeps the strings, the templates and the regular expressions, and skips the comments', () => {
    let source = [
      "// REV-1 in a comment",
      "/** REV-2 in a doc comment */",
      "let a = 'one' // REV-3",
      'let b = "two", c = `three ${a + `four ${"five"}`} six`',
      "let d = x / 2 / y, e = /seven[/]/i.test(a) ? { f: 'eight' } : {}",
      "return 'nine'",
    ].join('\n')
    let strings = stringsOf(source)
    assert.deepEqual(strings, ['one', 'two', 'three ', 'four ', 'five', '', ' six', 'seven[/]', 'eight', 'nine'])
    assert.ok(!strings.some((s) => TICKET_ID.test(s)))
    assert.ok(stringsOf("let t = 'Fixed in REV-42.'").some((s) => TICKET_ID.test(s)))
  })

  it('keeps the text of the JSX of a screen in the code, without its comments', () => {
    let { code } = scanSource('let p = (\n  <p>\n    {/* REV-91: a note */}\n    Fixed in REV-12.\n  </p>\n)')
    assert.ok(code.includes('Fixed in REV-12.'), code)
    assert.ok(!code.includes('REV-91'), code)
  })
})

describe('no ticket id in the texts of the bot', () => {
  it('no string of the web service or of the engine holds one', () => {
    let files = [
      // The screens too: the page of the commands is linked from GitHub, and a screen shows what the bot posted.
      ...sources(join(ROOT, 'apps/web/app'), (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)),
      join(ROOT, 'apps/web/server.ts'),
      // The reason of a failure of the runner goes into the comment of a failed job.
      ...sources(join(ROOT, 'apps/runner/src'), (f) => f.endsWith('.ts')),
      ...sources(join(ROOT, 'packages/engine/src'), (f) => f.endsWith('.ts')),
      ...sources(join(ROOT, 'packages/protocol/src'), (f) => f.endsWith('.ts')),
    ]
    assert.ok(files.length > 50, `only ${files.length} files`)
    let found: string[] = []
    let count = 0
    for (let file of files) {
      let { strings, code } = scanSource(readFileSync(file, 'utf8'))
      for (let text of strings) {
        count++
        // A comment of SQL (`-- REV-59. …`) goes to Postgres, never to GitHub.
        if (TICKET_ID.test(text.replace(SQL_COMMENT, ''))) found.push(`${relative(ROOT, file)}: ${text.slice(0, 120)}`)
      }
      let inCode = TICKET_ID.exec(code)
      if (inCode) found.push(`${relative(ROOT, file)}: ${code.slice(Math.max(0, inCode.index - 60), inCode.index + 60)}`)
    }
    // The scanner reads the code: a bug that swallowed it would find nothing.
    assert.ok(count > 2000, `only ${count} strings`)
    assert.deepEqual(found, [], found.join('\n'))
  })

  it('no prompt of the model holds one: the model can copy it into a finding', () => {
    let prompts = sources(join(ROOT, 'packages/engine/prompts'), (f) => f.endsWith('.md'))
    assert.ok(prompts.length > 0)
    for (let file of prompts) assert.ok(!TICKET_ID.test(readFileSync(file, 'utf8')), relative(ROOT, file))
  })

  it('a published review, its threads, block, label and check hold none', async () => {
    let posted = await publishRichReview()
    for (let text of posted) assert.ok(!TICKET_ID.test(text), text.slice(0, 300))
  })

  it('the replies of the bot hold none', () => {
    let texts = [
      usage('https://review.test/docs/commands'),
      ...(['reason_missing', 'reason_long', 'id_missing', 'id_in_thread'] as const).map(rejectProblemText),
      hintText('https://review.test/docs/commands'),
      feedbackEmptyText(),
      requestText('octocat', 3),
      failureComment({ id: 'j', kind: 'review', level: 'lite', headSha: 'a'.repeat(40), failureReason: 'model error', commenter: 'octocat', configUrl: 'https://review.test/c' }),
      capSentence({ period: 'month', capUsd: 10, spentUsd: 10, resetsAt: new Date('2026-12-01T00:00:00Z') }),
    ]
    for (let text of texts) assert.ok(!TICKET_ID.test(text), text)
  })
})
