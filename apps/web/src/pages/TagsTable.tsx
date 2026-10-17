import { useState } from 'react'
import { TAG_TARGET_LABELS } from '@ad/types'
import { Button, Modal } from '@/components/ui'
import type { DraftType } from '@/pages/WorkspacePage'
import './tags-table.css'

type Editor = (t: DraftType, at: number) => React.ReactNode

/** The workspace's tag types: one row each, its values as pills; Edit opens the type in a dialog. */
export function TagsTable({
  types,
  canManage,
  editor,
}: {
  types: DraftType[]
  canManage: boolean
  editor: Editor
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const t = editing == null ? undefined : types[editing]
  return (
    <>
      <div className="ad-tablewrap">
        <table className="ad-table">
          <thead>
            <tr>
              <th>Tag type</th>
              <th>Used on</th>
              <th>Values</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {types.map((x, at) => (
              <tr key={x.key ?? `new-${at}`}>
                <td className="font-semibold">
                  {x.label || <span className="text-soft">New</span>}
                </td>
                <td className="text-sm">
                  {x.appliesTo.map((a) => TAG_TARGET_LABELS[a]).join(', ') || '—'}
                </td>
                <td>
                  <span className="tv-chips">
                    {x.values.map((v, n) => (
                      <span key={v.key ?? `new-${n}`} className="tv-pill">
                        {v.label}
                      </span>
                    ))}
                    {x.values.length === 0 && <span className="text-soft">No values yet</span>}
                  </span>
                </td>
                {canManage && (
                  <td className="ad-num">
                    <Button size="sm" onClick={() => setEditing(at)}>
                      Edit
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t && editing != null && (
        <Modal title={`Edit ${t.label || 'tag type'}`} onClose={() => setEditing(null)}>
          <div className="grid gap-3">
            {editor(t, editing)}
            <p className="text-xs text-soft">Changes are kept here until you press Save tags.</p>
            <div className="flex justify-end">
              <Button kind="primary" onClick={() => setEditing(null)}>
                Done
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
