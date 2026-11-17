import { describe, expect, it } from 'vitest'
import { canView } from './DocumentViewer'

describe('canView', () => {
  it('shows every type an upload takes in the app', () => {
    for (const fileName of ['a.pdf', 'a.png', 'a.jpg', 'a.jpeg', 'a.csv', 'a.xlsx', 'a.docx'])
      expect(canView({ fileName })).toBe(true)
    expect(
      canView({
        fileName: 'no-extension',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
    ).toBe(true)
  })

  it('leaves another type to its link', () => {
    expect(canView({ fileName: 'a.zip', contentType: 'application/zip' })).toBe(false)
  })
})
