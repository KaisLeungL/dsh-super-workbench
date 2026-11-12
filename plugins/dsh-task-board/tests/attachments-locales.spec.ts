/**
 * The attachment copy: the languages the board ships carry the same keys with
 * the same placeholders, so an attachment control is never half translated.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/** Every key the attachment surface uses. */
const attachmentKeys = [
  'new.attachments',
  'new.attachmentsHint',
  'new.attachments.drop',
  'new.attachments.pick',
  'new.attachments.remove',
  'new.attachments.limitCount',
  'new.attachments.limitSize',
  'new.attachments.limitTotal',
  'new.attachments.limitImages',
  'new.attachments.limitImageBytes',
  'new.attachments.unavailable',
  'new.attachments.uploading',
  'detail.attachments',
  'detail.attachments.removeHint',
] as const

/** The placeholders one message carries. */
function placeholders(text: string): string[] {
  return (text.match(/\{[a-zA-Z]+\}/g) ?? []).sort()
}

describe('the attachment copy', () => {
  it('operator reading the attachment copy finds every key in every language', () => {
    // Given the dictionaries the board ships
    // When the attachment keys are read
    // Then every language carries every key of the attachment surface
    for (const key of attachmentKeys) {
      expect(Object.keys(zh)).toContain(key)
      expect(Object.keys(en)).toContain(key)
    }
  })

  it('operator reading an attachment message sees the same placeholders in every language', () => {
    // Given the dictionaries the board ships
    // When the attachment messages are read
    // Then the placeholders of the two languages match
    for (const key of attachmentKeys) {
      expect(placeholders(en[key])).toEqual(placeholders(zh[key]))
    }
  })

  it('operator reading the removal notice learns that the stored file stays', () => {
    // Given the removal notice of the detail view
    // When the operator reads it
    // Then it says the reference is dropped and the file is not deleted
    expect(en['detail.attachments.removeHint']).toContain('not physically deleted')
    expect(zh['detail.attachments.removeHint']).toContain('不会被物理删除')
  })
})
