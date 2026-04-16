import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripChatNarration } from '../server/lib/chat-session.js'

describe('stripChatNarration', () => {
  it('passes clean text through unchanged', () => {
    assert.equal(stripChatNarration('Hello, how are you?'), 'Hello, how are you?')
  })

  it('strips balanced <internal>...</internal> block', () => {
    const input = '<internal>{"thought":"reasoning"}</internal>\n\nMy actual reply.'
    assert.equal(stripChatNarration(input), 'My actual reply.')
  })

  it('strips <internal> with XML-parameter style', () => {
    const input = `<internal>
<parameter name="thought">Let me think</parameter>
<parameter name="trigger">true</parameter>
</internal>

Noted.`
    assert.equal(stripChatNarration(input), 'Noted.')
  })

  it('strips unbalanced <internal>... (truncated mid-stream)', () => {
    const input = '<internal>\n{\n  "thought": "This was truncated before closing'
    assert.equal(stripChatNarration(input), '')
  })

  it('strips orphan </internal> (closing-tag-only chunk)', () => {
    const input = '</internal>\n\nMy current focus is memory cleanup.'
    assert.equal(stripChatNarration(input), 'My current focus is memory cleanup.')
  })

  it('strips <thinking> and <execute_protocol> and <tool_code>', () => {
    assert.equal(stripChatNarration('<thinking>stuff</thinking>ok'), 'ok')
    assert.equal(stripChatNarration('<execute_protocol>stuff</execute_protocol>ok'), 'ok')
    assert.equal(stripChatNarration('<tool_code>stuff</tool_code>ok'), 'ok')
  })

  it('strips JSON reasoning blob at start', () => {
    const input = '{ "thought": "Tester asking for status. I\'m moderator." } My current focus is memory cleanup.'
    const out = stripChatNarration(input)
    assert.equal(out, 'My current focus is memory cleanup.')
  })

  it('strips JSON reasoning blob at start (backchannel shape)', () => {
    const input = '{"backchannel": "All agents respond", "trigger": true}\n\nHi.'
    assert.equal(stripChatNarration(input), 'Hi.')
  })

  it('strips MULTIPLE leading JSON reasoning blobs', () => {
    const input = '{ "thought": "first reasoning" } { "thought": "second reasoning" } My actual reply.'
    assert.equal(stripChatNarration(input), 'My actual reply.')
  })

  it('strips three or more leading JSON reasoning blobs', () => {
    const input = '{"thought": "a"} {"thought": "b"} {"thought": "c"} Final.'
    assert.equal(stripChatNarration(input), 'Final.')
  })

  it('strips reproduced Red failure (two thought blobs then prose)', () => {
    const input = '{ "thought": "Session restart. I need to check my state." } { "thought": "State loaded. I\'m at session 90, focused on memory cleanup." } My focus is on memory cleanup, tracking Blue\'s memory divergence, and monitoring known operational issues.'
    const out = stripChatNarration(input)
    assert.ok(!out.includes('"thought"'))
    assert.ok(out.startsWith('My focus'))
  })

  it('strips tool_code fenced blocks', () => {
    const input = '```tool_code\nprint(get_state())\n```\nUnderstood.'
    assert.equal(stripChatNarration(input), 'Understood.')
  })

  it('strips multiple narration artifacts in one pass', () => {
    const input = '<thinking>alpha</thinking>\n<internal>{"thought":"beta"}</internal>\n\nFinal answer.'
    assert.equal(stripChatNarration(input), 'Final answer.')
  })

  it('leaves empty string when text is pure narration', () => {
    assert.equal(stripChatNarration('<internal>{"thought":"only thinking"}</internal>'), '')
  })

  it('handles null/empty input', () => {
    assert.equal(stripChatNarration(''), '')
    assert.equal(stripChatNarration(null), null)
    assert.equal(stripChatNarration(undefined), undefined)
  })
})
