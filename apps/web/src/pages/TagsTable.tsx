import { TAG_TARGET_LABELS } from '@ad/types'
import { Button } from '@/components/ui'
import type { DraftType } from '@/pages/WorkspacePage'
import './tags-table.css'

/** The workspace's tag groups: one row each, its values as pills; Edit opens the group in a dialog. */
export function TagsTable({
  types,
  canManage,
  onEdit,
}: {
  types: DraftType[]
  canManage: boolean
  onEdit: (at: number) => void
}) {
  return (
    <div className="ad-tablewrap">
      <table className="ad-table">
        <thead>
          <tr>
            <th>Tag Group</th>
            <th>Applies To</th>
            <th>Values</th>
            {canManage && <th></th>}
          </tr>
        </thead>
        <tbody>
          {types.map((x, at) => (
            <tr key={x.key ?? `new-${at}`}>
              <td className="font-semibold">{x.label || <span className="text-soft">New</span>}</td>
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
                  <Button size="sm" kind="navy" onClick={() => onEdit(at)}>
                    Edit
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
