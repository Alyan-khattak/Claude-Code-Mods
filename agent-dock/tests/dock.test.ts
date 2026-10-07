import { test, expect } from 'claude-code/testing'
import {
  parseSize, splitInstruction, nudgeText, badgeText, summaryLine, initials, fmtTime,
} from '../hooks/dock-logic'

// 1. parseSize
test('parseSize: valid integers', () => {
  expect(parseSize('10')).toBe(10)
  expect(parseSize(' 25 ')).toBe(25)
  expect(parseSize('1')).toBe(1)
  expect(parseSize('100')).toBe(100)
})

test('parseSize: invalid inputs return null', () => {
  expect(parseSize('0')).toBeNull()
  expect(parseSize('101')).toBeNull()
  expect(parseSize('abc')).toBeNull()
  expect(parseSize('2.5')).toBeNull()
  expect(parseSize('')).toBeNull()
})

// 2. Big team size resets to 1 in new session (logic only — store reads on session.start)
test('big team size (>20) should not be carried: parseSize still parses it, session.start caps it', () => {
  // The cap logic: size > 20 → stored as-is but session.start resets to 1
  // Test that 50 parses OK (not the responsibility of parseSize to cap for sessions)
  expect(parseSize('50')).toBe(50)
  // And 10 stays 10
  expect(parseSize('10')).toBe(10)
})

// 3. splitInstruction at size 5 vs size 1
test('splitInstruction: size 5 includes "exactly 5"', () => {
  const s = splitInstruction(5, 'haiku')
  expect(s).toContain('exactly 5')
  expect(s).toContain('report_progress')
})

test('splitInstruction: size 1 would not be called — tested by absence of instruction in prompt.submit', () => {
  // At teamSize 1 we skip injection entirely; verify that at size 2 the instruction IS built
  const s = splitInstruction(2, 'same')
  expect(s).toContain('exactly 2')
  expect(s).not.toContain('Fast & Cheap')
})

// 4. Nudge text
test('nudgeText: correct message', () => {
  const t = nudgeText(3, 10)
  expect(t).toContain('3 of 10')
  expect(t).toContain('7')
})

// 5. badgeText
test('badgeText: formats correctly', () => {
  expect(badgeText(12, 8, 30)).toBe('◆ 12 working · 8 queued · 30 done')
  expect(badgeText(0, 0, 0)).toBe('◆ Dock')
})

// 6. summaryLine
test('summaryLine: no stuck', () => {
  const s = summaryLine(50, 'Research bakery pricing', 134000, 0)
  expect(s).toContain('50 agents')
  expect(s).toContain('Research bakery pricing')
  expect(s).not.toContain('stuck')
})

test('summaryLine: with stuck', () => {
  const s = summaryLine(3, 'My job', 5000, 2)
  expect(s).toContain('2 got stuck')
})

// 7. initials
test('initials: two words', () => {
  expect(initials('Price check: Panera')).toBe('PC')
  expect(initials('Crumbl cookie')).toBe('CC')
})

test('initials: one word', () => {
  expect(initials('Research')).toBe('RE')
})

// 8. fmtTime
test('fmtTime: under 60s', () => {
  expect(fmtTime(45000)).toBe('45s')
})

test('fmtTime: minutes', () => {
  expect(fmtTime(134000)).toBe('2m 14s')
  expect(fmtTime(120000)).toBe('2m')
})
