/**
 * Preview demo definition lockstep (2026-08-28 report BUG 3).
 *
 * The standalone preview's "校验 → 注册 → 播放" button seeds its textarea
 * with a copy of the motion-format.md §10 example. When the 2026-08-27
 * same-layer easing tightening fixed the DOC example (and the DOC_EXAMPLE in
 * animation-definition.test.ts), this copy was missed and the preview's
 * headline demo shipped permanently broken. This file makes the invariant a
 * test: the demo validates AND is exactly the documented example.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateAnimationDefinition } from '../../src/motion/animation-definition'
import { DEMO_CUSTOM_DEFINITION_TEXT } from '../../src/preview/demo-definition'

const docPath = fileURLToPath(new URL('../../docs/motion-format.md', import.meta.url))

/** The §10 slam-land example block from the docs (the only block using that id). */
function docExample(): Record<string, unknown> {
  const markdown = readFileSync(docPath, 'utf8')
  const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!)
  const slam = blocks.find((block) => block.includes('"user:slam-land"'))
  if (slam === undefined) throw new Error('motion-format.md no longer contains the slam-land example')
  return JSON.parse(slam) as Record<string, unknown>
}

describe('preview demo definition (docs §10 lockstep)', () => {
  it('parses and passes the validator — the demo button works out of the box', () => {
    const definition: unknown = JSON.parse(DEMO_CUSTOM_DEFINITION_TEXT)
    expect(validateAnimationDefinition(definition)).toEqual({ valid: true })
  })

  it('is byte-for-byte the motion-format.md §10 example (parsed deep-equal)', () => {
    expect(JSON.parse(DEMO_CUSTOM_DEFINITION_TEXT)).toEqual(docExample())
  })
})
