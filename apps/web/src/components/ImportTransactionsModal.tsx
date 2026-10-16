import { Fragment, useState } from 'react'
import {
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_SKIP,
  REPORT_LINE_LABELS,
  type ImportCategories,
  type ImportColumns,
  type ImportField,
  type ImportFileDto,
  type ImportPreviewDto,
  type ImportRequest,
  type ImportResultDto,
  type ImportRowDto,
  type ImportSuggestionDto,
} from '@ad/types'
import { useApi } from '@/hooks/useApi'
import { HandCard } from '@/components/HandCard'
import { money, periodLabel, shortDate } from '@/lib/format'
import { Button, Chip, ErrorNote, Field, Modal, Stepper, inputClass } from '@/components/ui'

const STEPS = ['File', 'Columns', 'Budget lines', 'Preview', 'Done'] as const
type Step = (typeof STEPS)[number]

// What each column is often called in an export, so the person finds it in their own file.
const FIELD_HINTS: Partial<Record<ImportField, string>> = {
  vendor: 'Often Name, Payee or Supplier in the file.',
  amount: 'Often Amount or Total; in a bank file, the money out column (Debit or Withdrawal).',
  reference: 'Often Num, Ref or Check no. Without one, each line gets IMP-1, IMP-2, …',
  category:
    "The file's category column (often Category or Split). You match each category to a budget line in step 3.",
  memo: 'Often Memo or Description.',
  account: 'Often Account. An auditor uses it to match your ledger.',
}
const REQUIRED: ImportField[] = ['date', 'vendor', 'amount']
// The Add expense form's three groups, in its order.
const GROUPS: { title: string; optional?: boolean; fields: ImportField[] }[] = [
  {
    title: 'What was bought',
    // The file's money out and money in columns are another way to give the total cost, chosen under it.
    fields: ['vendor', 'date', 'amount', 'reference'],
  },
  { title: 'Where it is charged', fields: ['category'] },
  { title: 'Details', optional: true, fields: ['memo', 'account'] },
]
const WIDE: ImportField[] = ['vendor', 'reference', 'category']

/**
 * A sample file for a team that keeps no accounting system: its column names are ones the import recognises on its
 * own, so it maps itself. Fictional rows, meant to be replaced.
 */
const SAMPLE_CSV = [
  'Date,Reference,Vendor,Memo,Account,Category,Amount',
  '09/03/2026,INV-1042,Bright Path Office Supply,Printer paper and toner,6100 Office Supplies,Supplies,212.18',
  '09/08/2026,CHK-2201,Clearwater Bookkeeping LLC,September bookkeeping,6070 Accounting Fees,Contractual / Subawards,1250.00',
  '09/15/2026,CARD-0915,Lakeside Transit Co.,Bus passes for participants,6300 Program Costs,Participant / Training Costs,180.00',
].join('\r\n')

const SAMPLE_COLUMNS: [string, string][] = [
  ['Date', 'the day it was paid, as 09/03/2026 or 2026-09-03; it decides the month'],
  ['Reference', 'your invoice, check or transaction number'],
  ['Vendor', 'who was paid'],
  ['Memo', 'what it was for (optional)'],
  ['Account', 'the account in your books (optional)'],
  ['Category', 'your own word for the cost; you match each one to a budget line in step 3'],
  ['Amount', 'what was spent, as a positive number'],
]

const downloadSample = () => {
  const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'transactions-sample.csv'
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Import transactions from a file the team exports (a QuickBooks report, or another CSV or Excel file): pick the
 * file, say which column holds what, map its categories to the engagement's budget lines, check the preview, import.
 * The file goes to the server again at each step and is never stored there.
 */
export function ImportTransactionsModal({
  engagementId,
  reportId,
  onClose,
  onImported,
}: {
  engagementId: string
  /** Opened from a month's page: the answer then carries that page. */
  reportId?: string
  onClose: () => void
  /** The engagement and the month as they now stand, so the page shows them without fetching again. */
  onImported: (result: ImportResultDto) => void
}) {
  const api = useApi()
  const [step, setStep] = useState<Step>('File')
  const [file, setFile] = useState<File | null>(null)
  const [info, setInfo] = useState<ImportFileDto | null>(null)
  const [columns, setColumns] = useState<ImportColumns>({})
  const [categories, setCategories] = useState<ImportCategories>({})
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null)
  const [save, setSave] = useState(true)
  const [saveAs, setSaveAs] = useState('QuickBooks mapping')
  const [result, setResult] = useState<ImportResultDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Asked each import: AI suggests the columns only when the person presses the button, and nothing remembers it.
  const [aiSuggested, setAiSuggested] = useState<'yes' | 'nothing' | null>(null)
  // A file with no budget-line column: each row's budget line, by its line in the file, set one by one or in bulk.
  const [rowLines, setRowLines] = useState<Record<string, string>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState('')
  const [rowSearch, setRowSearch] = useState('')
  const base = `/engagements/${engagementId}/imports`

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const form = (body?: ImportRequest) => {
    const f = new FormData()
    f.append('file', file!)
    if (body) f.append('mapping', JSON.stringify(body))
    return f
  }
  // A saved mapping is offered only when every column it names is in this file: one made for another file's columns
  // cannot be used here, so it is not listed.
  const fits = (m: ImportFileDto['mappings'][number], headers: string[]) =>
    IMPORT_FIELDS.every((f) => !m.columns[f] || headers.includes(m.columns[f] as string))
  const usable = info ? info.mappings.filter((m) => fits(m, info.headers)) : []
  // Every problem with the columns at once, beside its field, so nothing is found one at a time.
  const problems: Partial<Record<(typeof IMPORT_FIELDS)[number], string>> = {}
  if (info) {
    for (const f of IMPORT_FIELDS) {
      const v = columns[f]
      if (v && !info.headers.includes(v))
        problems[f] = `This file has no column "${v}". Choose one.`
    }
    if (!columns.date) problems.date ??= 'Choose the column that holds the date.'
    if (!columns.vendor) problems.vendor ??= 'Choose the column that holds the vendor.'
    if (!columns.amount)
      problems.amount ??= 'Choose the column that holds the total cost (in a bank file, money out).'
  }
  const problemCount = Object.keys(problems).length
  // Step 3 without a budget-line column: the rows the search finds (vendor, memo, date or amount), and those only are
  // what "Select all" selects.
  const q = rowSearch.trim().toLowerCase()
  const shownRows = !preview
    ? []
    : q
      ? preview.assignable.filter((r) =>
          [r.vendor, r.memo, r.date ?? '', r.amount == null ? '' : r.amount.toFixed(2)]
            .join(' ')
            .toLowerCase()
            .includes(q)
        )
      : preview.assignable
  const allShownPicked = shownRows.length > 0 && shownRows.every((r) => picked.has(String(r.line)))
  // Step 3: what still has no budget line (a value of the column, or a row of a file without one).
  const linesLeft = !preview
    ? 0
    : columns.category
      ? preview.categories.filter((c) => !categories[c.value]).length
      : preview.assignable.filter((r) => !rowLines[String(r.line)]).length
  const lineSelect = (value: string, onChange: (v: string) => void, label: string) =>
    info && (
      <select
        className={inputClass}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose…</option>
        {info.budgetOptions.map((i) => (
          <option key={i.key} value={i.key}>
            {i.label} ({REPORT_LINE_LABELS[i.reportLine]})
          </option>
        ))}
        <option value={IMPORT_SKIP}>Skip (do not import)</option>
      </select>
    )
  /** One line at the top of step 3: how many are done, how many still need a budget line. */
  const lineSummary = (left: number, matched: number, what: 'value' | 'row') =>
    left > 0 ? (
      <p className="ad-field-error-sum" role="status">
        {left}{' '}
        {what === 'value'
          ? left === 1
            ? 'value needs'
            : 'values need'
          : left === 1
            ? 'row needs'
            : 'rows need'}{' '}
        a budget line before the next step.
        {matched > 0 && <span className="text-soft"> {matched} matched by name.</span>}
      </p>
    ) : (
      <p className="text-sm text-soft">
        Every {what} has a budget line.{matched > 0 && ` ${matched} matched by name.`}
      </p>
    )
  /** One field's column picker: the file's columns, or "Not in this file". */
  const pick = (f: ImportField, label = IMPORT_FIELD_LABELS[f]) =>
    info && (
      <Field
        key={f}
        label={label}
        required={REQUIRED.includes(f)}
        hint={FIELD_HINTS[f]}
        error={problems[f]}
        className={WIDE.includes(f) ? 'sm:col-span-2' : ''}
      >
        <select
          className={inputClass}
          value={columns[f] ?? ''}
          onChange={(e) => setColumns({ ...columns, [f]: e.target.value || undefined })}
        >
          <option value="">Not in this file</option>
          {info.headers.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </Field>
    )

  // Only money paid out is imported: an older mapping's or AI's money-out column becomes the total cost.
  const outOnly = (c: ImportColumns): ImportColumns => {
    const next: ImportColumns = { ...c, amount: c.amount ?? c.debit }
    delete next.debit
    delete next.credit
    return next
  }
  const applyMapping = (id: string) => {
    const m = usable.find((x) => x.id === id)
    if (!m) return
    setColumns(outOnly(m.columns))
    setCategories(m.categories)
    setSaveAs(m.name)
  }

  const read = () =>
    run(async () => {
      const got = await api.upload<ImportFileDto>(`${base}/read`, form())
      setInfo(got)
      setAiSuggested(null)
      setColumns(outOnly(got.guess))
      const saved = got.mappings.find((m) => m.id === got.mappingId)
      setCategories(saved?.categories ?? {})
      if (saved) setSaveAs(saved.name)
      setStep('Columns')
    })
  const suggest = () =>
    run(async () => {
      const got = await api.upload<ImportSuggestionDto>(`${base}/suggest`, form())
      if (got.columns) setColumns(outOnly({ ...got.columns, flipSign: columns.flipSign }))
      setAiSuggested(got.columns ? 'yes' : 'nothing')
    })
  const toCategories = () =>
    run(async () => {
      const got = await api.upload<ImportPreviewDto>(
        `${base}/preview`,
        form({ columns, categories, lines: columns.category ? undefined : rowLines })
      )
      // Values that name a budget line are pre-filled; the person confirms them and maps the rest.
      setCategories((c) => {
        const next = { ...c }
        for (const v of got.categories) if (!next[v.value] && v.match) next[v.value] = v.match
        return next
      })
      setPreview(got)
      setStep('Budget lines')
    })
  const toPreview = () =>
    run(async () => {
      setPreview(
        await api.upload<ImportPreviewDto>(
          `${base}/preview`,
          form({ columns, categories, lines: columns.category ? undefined : rowLines })
        )
      )
      setStep('Preview')
    })
  const doImport = () =>
    run(async () => {
      const done = await api.upload<ImportResultDto>(
        base,
        form({
          columns,
          categories,
          lines: columns.category ? undefined : rowLines,
          reportId,
          aiSuggested: aiSuggested === 'yes',
          ...(save ? { saveAs } : {}),
        })
      )
      setResult(done)
      onImported(done)
      setStep('Done')
    })

  return (
    <Modal title="Import transactions" onClose={onClose} wide>
      <Stepper steps={STEPS} current={step} />
      <ErrorNote message={error} />

      {step === 'File' && (
        <div className="grid gap-4">
          <p className="text-sm text-soft">
            Export the transactions from your accounting system (in QuickBooks: Reports, Transaction
            Report, then Export to CSV or Excel). Each row becomes an expense line in the month of
            its date. The file is read, never stored.
          </p>
          <details className="ad-import-sample">
            <summary>No accounting system? Start from a sample file</summary>
            <p className="text-sm text-soft">
              Fill one row per payment in a spreadsheet, save it as CSV, and choose it below. Keep
              these column names and the import matches them on its own:
            </p>
            <ul className="text-sm">
              {SAMPLE_COLUMNS.map(([name, what]) => (
                <li key={name}>
                  <b>{name}</b>: {what}
                </li>
              ))}
            </ul>
            <Button kind="navy" size="sm" onClick={downloadSample}>
              Download the sample (CSV)
            </Button>
            <p className="text-xs text-soft">
              Its three rows are examples: replace them with your own before you import.
            </p>
          </details>
          <Field label="File" hint="CSV or XLSX, up to 5 MB and 5,000 rows">
            <input
              type="file"
              accept=".csv,.xlsx"
              className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <Actions onClose={onClose} busy={busy}>
            <Button kind="primary" onClick={read} disabled={!file || busy}>
              Next: columns
            </Button>
          </Actions>
        </div>
      )}

      {step === 'Columns' && info && (
        <div className="grid gap-4">
          {problemCount > 0 && (
            <p className="ad-field-error-sum" role="status">
              {problemCount === 1 ? '1 column needs' : `${problemCount} columns need`} a choice
              before the next step:{' '}
              {Object.keys(problems)
                .map((f) => IMPORT_FIELD_LABELS[f as (typeof IMPORT_FIELDS)[number]])
                .join(', ')}
              .
            </p>
          )}
          <p className="text-sm text-soft">
            {info.fileName}: {info.rowCount.toLocaleString('en-US')} rows.{' '}
            {aiSuggested === 'yes'
              ? 'AI suggested these from the column names alone. Check each one.'
              : info.guessedBy === 'saved'
                ? 'The columns come from your saved mapping.'
                : 'Guessed from the column names. Check each one.'}
          </p>
          {info.aiAvailable && (
            <div className="ad-ai-optin flex flex-wrap items-center gap-3">
              <span className="ad-ai-tag">✨ Optional AI Automation</span>
              <Button kind="secondary" size="sm" onClick={suggest} disabled={busy}>
                Suggest the mapping with AI
              </Button>
              <small className="text-soft">
                {aiSuggested === 'nothing'
                  ? 'AI had no suggestion; the columns are as they were.'
                  : 'Sends the column names to an AI model, not the rows. You still check each one.'}
              </small>
            </div>
          )}
          {usable.length > 0 && (
            <Field label="Saved mapping">
              <select
                className={inputClass}
                defaultValue={info.mappingId ?? ''}
                onChange={(e) => applyMapping(e.target.value)}
              >
                <option value="">None</option>
                {usable.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {m.matches ? ' (made for these columns)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="ad-entry">
            {GROUPS.map((g, gi) => (
              <fieldset key={g.title} className="ad-entry-group">
                <legend>
                  <b>{gi + 1}</b> {g.title}
                  {g.optional && <span className="text-soft"> (optional)</span>}
                </legend>
                {g.fields.map((f) =>
                  f === 'amount' ? (
                    <Fragment key={f}>
                      {pick('amount')}
                      <label className="ad-flip flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!!columns.flipSign}
                          onChange={(e) => setColumns({ ...columns, flipSign: e.target.checked })}
                        />
                        Spending shows as negative amounts
                      </label>
                    </Fragment>
                  ) : (
                    pick(f)
                  )
                )}
              </fieldset>
            ))}
          </div>
          <div>
            <p className="ad-group-title">The first rows of the file</p>
            <div className="ad-tablewrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    {info.headers.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {info.sample.map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j}>{c}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <Actions
            onClose={onClose}
            busy={busy}
            onBack={() => {
              setFile(null)
              setStep('File')
            }}
          >
            <Button kind="primary" onClick={toCategories} disabled={busy || problemCount > 0}>
              Next: budget lines
            </Button>
          </Actions>
        </div>
      )}

      {step === 'Budget lines' && info && preview && (
        <div className="grid gap-4">
          {info.budgetOptions.length === 0 ? (
            <HandCard
              title="No budget lines yet"
              icon="📋"
              lead="Add the approved budget first, then import."
            >
              <p>
                The budget is step 4 of the engagement. Each imported line is charged to one of its
                lines.
              </p>
            </HandCard>
          ) : columns.category ? (
            <>
              {lineSummary(
                preview.categories.filter((c) => !categories[c.value]).length,
                preview.categories.filter((c) => c.match && categories[c.value] === c.match).length,
                'value'
              )}
              <div className="ad-tablewrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th>{columns.category} in the file</th>
                      <th className="ad-num">Rows</th>
                      <th className="ad-num">Amount</th>
                      <th>Budget line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...preview.categories]
                      .sort((a, b) => Number(!!categories[a.value]) - Number(!!categories[b.value]))
                      .map((c) => (
                        <tr key={c.value}>
                          <td>{c.value || <i>Blank</i>}</td>
                          <td className="ad-num">{c.rows}</td>
                          <td className="ad-num">{money(c.total)}</td>
                          <td>
                            {lineSelect(
                              categories[c.value] ?? '',
                              (v) => setCategories({ ...categories, [c.value]: v }),
                              `Budget line for ${c.value || 'blank rows'}`
                            )}
                            {!categories[c.value] ? (
                              <small className="ad-field-error">
                                Choose a budget line or skip.
                              </small>
                            ) : (
                              c.match &&
                              categories[c.value] === c.match && (
                                <small className="text-soft">✓ Matched by name</small>
                              )
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              {lineSummary(
                preview.assignable.filter((r) => !rowLines[String(r.line)]).length,
                0,
                'row'
              )}
              <div className="ad-bulkbar">
                <label className="ad-search">
                  <svg
                    className="ad-search-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="M15.5 15.5 21 21" />
                  </svg>
                  <input
                    type="search"
                    placeholder="Search vendor, memo, date or amount"
                    aria-label="Search the rows"
                    value={rowSearch}
                    onChange={(e) => setRowSearch(e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allShownPicked}
                    onChange={(e) => {
                      const next = new Set(picked)
                      for (const r of shownRows)
                        if (e.target.checked) next.add(String(r.line))
                        else next.delete(String(r.line))
                      setPicked(next)
                    }}
                  />
                  {q ? `Select all ${shownRows.length} found` : 'Select all'}
                </label>
                <span className="text-sm text-soft">{picked.size} selected</span>
                {lineSelect(bulk, setBulk, 'Budget line for the selected rows')}
                <Button
                  kind="navy"
                  size="sm"
                  disabled={!picked.size || !bulk}
                  onClick={() => {
                    const next = { ...rowLines }
                    for (const l of picked) next[l] = bulk
                    setRowLines(next)
                    setPicked(new Set())
                  }}
                >
                  Set for selected
                </Button>
              </div>
              <div className="ad-tablewrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th>Date</th>
                      <th>Vendor</th>
                      <th>Memo</th>
                      <th className="ad-num">Total cost</th>
                      <th>Budget line</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="text-soft">
                          No row matches &ldquo;{rowSearch}&rdquo;.
                        </td>
                      </tr>
                    )}
                    {shownRows.map((r) => {
                      const k = String(r.line)
                      return (
                        <tr key={k}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${r.vendor}`}
                              checked={picked.has(k)}
                              onChange={(e) => {
                                const next = new Set(picked)
                                if (e.target.checked) next.add(k)
                                else next.delete(k)
                                setPicked(next)
                              }}
                            />
                          </td>
                          <td className="whitespace-nowrap">{r.date ? shortDate(r.date) : ''}</td>
                          <td>{r.vendor}</td>
                          <td className="text-sm">{r.memo}</td>
                          <td className="ad-num">{r.amount == null ? '' : money(r.amount)}</td>
                          <td>
                            {lineSelect(
                              rowLines[k] ?? '',
                              (v) => setRowLines({ ...rowLines, [k]: v }),
                              `Budget line for ${r.vendor}`
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <Actions onClose={onClose} busy={busy} onBack={() => setStep('Columns')}>
            <Button kind="primary" onClick={toPreview} disabled={busy || linesLeft > 0}>
              Next: preview
            </Button>
          </Actions>
        </div>
      )}

      {step === 'Preview' && preview && (
        <div className="grid gap-4">
          {preview.months.length === 0 ? (
            <p className="ad-field-error-sum" role="status">
              No row is ready to import. Each one is listed below with why.
            </p>
          ) : (
            <div className="ad-tablewrap">
              <table className="ad-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th className="ad-num">Transactions</th>
                    <th className="ad-num">Amount</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {preview.months.map((m) => (
                    <tr key={m.period}>
                      <td>{periodLabel(m.period)}</td>
                      <td className="ad-num">{m.rows}</td>
                      <td className="ad-num">{money(m.total)}</td>
                      <td>{m.isNew && <Chip tone="info">New month, started as a draft</Chip>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.rows.length > 0 && <RowsTable title="To import" rows={preview.rows} />}
          {preview.notImported.length > 0 && (
            <RowsTable title="Not imported" rows={preview.notImported} />
          )}
          <div className="grid gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
              Save this mapping for the next file
            </label>
            {save && (
              <Field label="Mapping name" hint="Saved on the workspace; the same name replaces it">
                <input
                  className={inputClass}
                  maxLength={60}
                  value={saveAs}
                  onChange={(e) => setSaveAs(e.target.value)}
                />
              </Field>
            )}
          </div>
          <Actions onClose={onClose} busy={busy} onBack={() => setStep('Budget lines')}>
            <Button
              kind="primary"
              onClick={doImport}
              disabled={busy || preview.rows.length === 0 || (save && !saveAs.trim())}
            >
              Import {preview.rows.length}{' '}
              {preview.rows.length === 1 ? 'transaction' : 'transactions'}
            </Button>
          </Actions>
        </div>
      )}

      {step === 'Done' && result && (
        <div className="grid gap-4">
          <div className="ad-done">
            <span className="ad-done-check" aria-hidden="true">
              ✓
            </span>
            <h3>
              {result.imported} {result.imported === 1 ? 'transaction' : 'transactions'} imported
            </h3>
            <p>into {result.months.map((m) => periodLabel(m.period)).join(', ')}</p>
          </div>
          <div className="ad-done-tiles">
            <div className="ad-tile ad-tile-ok">
              <span className="ad-tile-label">Imported</span>
              <span className="ad-tile-value">{result.imported}</span>
            </div>
            <div className="ad-tile ad-tile-ok">
              <span className="ad-tile-label">Total</span>
              <span className="ad-tile-value">{money(result.total)}</span>
            </div>
            <div className={`ad-tile ${result.notImported ? 'ad-tile-warn' : ''}`}>
              <span className="ad-tile-label">Not imported</span>
              <span className="ad-tile-value">{result.notImported}</span>
            </div>
          </div>
          <HandCard
            title="What to do next"
            icon="📎"
            lead="Attach the invoice and proof of payment to each new line."
          >
            <p>
              Each line now goes through its month&apos;s checks; the month page shows what is
              missing.
            </p>
          </HandCard>
          <div className="ad-actions justify-end">
            <Button kind="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Actions({
  onClose,
  onBack,
  busy,
  children,
}: {
  onClose: () => void
  onBack?: () => void
  busy: boolean
  children: React.ReactNode
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
      <div>
        {onBack && (
          <Button kind="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
        )}
      </div>
      <div className="ad-actions">
        <Button kind="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        {children}
      </div>
    </div>
  )
}

/** The rows of the preview, the first 200 shown. A left-out row says why. */
function RowsTable({ title, rows }: { title: string; rows: ImportRowDto[] }) {
  const shown = rows.slice(0, 200)
  const out = rows.some((r) => r.reason)
  return (
    <div>
      <p className="ad-group-title">
        {title} ({rows.length})
      </p>
      <div className="ad-tablewrap ad-import-rows">
        <table className="ad-table">
          <thead>
            <tr>
              <th className="ad-num">Line</th>
              <th>Date</th>
              <th>Payee</th>
              <th className="ad-num">Amount</th>
              {out ? <th>Why</th> : <th>Item</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.line}>
                <td className="ad-num">{r.line}</td>
                <td>{r.date ? shortDate(r.date) : ''}</td>
                <td>{r.vendor}</td>
                <td className="ad-num">{r.amount == null ? '' : money(r.amount)}</td>
                <td>{r.reason ?? r.itemNumber}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length && (
        <p className="mt-1 text-sm text-soft">And {rows.length - shown.length} more.</p>
      )}
    </div>
  )
}
