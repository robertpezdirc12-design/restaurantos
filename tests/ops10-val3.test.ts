/**
 * OPS-10 val 3 (v1.79.0) — nabava + batch pure units, NO db fixtures.
 *
 * Covers:
 *  - src/lib/batch.ts: scaleBatchLines (scale, 3-dec rounding, zero removal,
 *    dedupe sum, garbage input), forecastQty (ceil average, empty/negative),
 *    batchCostPerUnit (0 guards, 4-dec rounding).
 *  - src/lib/ap-attachments.ts: base64ByteSize, sanitizeAttachments (1.5 MB
 *    budget → metadata-only + truncated, max 5, dedupe filename+sizeB,
 *    invalid mime tolerated, garbage input), oversizeNote.
 *  - src/lib/recurring-po.ts: clampRemindMinutes, parseRecurringConfig with
 *    remindMinutesBefore (default 60, clamp 0-1440, legacy rules untouched),
 *    dueInMs (positive/negative/Infinity), isRemindable (window boundaries,
 *    overdue anti-spam window, inactive/missing nextRun), dueTodayRules.
 *  - src/lib/eslog.ts: attachment extraction (EmbeddedDocumentBinaryObject,
 *    attributes, tolerant absence, multiple attachments) on top of parseEslog.
 *
 * Pure data only — no DB, no auth, no fixtures.
 */
import { describe, expect, test } from 'bun:test'
import {
  BATCH_STATUSES,
  scaleBatchLines,
  forecastQty,
  batchCostPerUnit,
} from '../src/lib/batch'
import {
  MAX_ATTACHMENTS_PER_AP,
  MAX_TOTAL_BASE64_LENGTH,
  base64ByteSize,
  sanitizeAttachments,
  oversizeNote,
} from '../src/lib/ap-attachments'
import {
  DEFAULT_REMIND_MINUTES_BEFORE,
  MAX_REMIND_MINUTES_BEFORE,
  parseRecurringConfig,
  clampRemindMinutes,
  dueInMs,
  isRemindable,
  dueTodayRules,
} from '../src/lib/recurring-po'
import { parseEslog } from '../src/lib/eslog'

/* ─────────── A) batch.ts ─────────── */

describe('batch: scaleBatchLines', () => {
  test('scales per-portion quantities by plannedQty with 3-dec rounding', () => {
    const out = scaleBatchLines([{ inventoryItemId: 'a', qty: 0.125 }, { inventoryItemId: 'b', qty: 1 }], 3)
    expect(out).toEqual([{ inventoryItemId: 'a', qty: 0.375 }, { inventoryItemId: 'b', qty: 3 }])
  })
  test('removes lines that round to 0', () => {
    const out = scaleBatchLines([{ inventoryItemId: 'a', qty: 0.0001 }, { inventoryItemId: 'b', qty: 2 }], 2)
    expect(out).toEqual([{ inventoryItemId: 'b', qty: 4 }])
  })
  test('invalid plannedQty → [] (0, negative, NaN); empty input → []', () => {
    expect(scaleBatchLines([{ inventoryItemId: 'a', qty: 1 }], 0)).toEqual([])
    expect(scaleBatchLines([{ inventoryItemId: 'a', qty: 1 }], -2)).toEqual([])
    expect(scaleBatchLines([{ inventoryItemId: 'a', qty: 1 }], Number.NaN)).toEqual([])
    expect(scaleBatchLines([], 5)).toEqual([])
  })
  test('dedupes by inventoryItemId with summing (defensive)', () => {
    const out = scaleBatchLines([{ inventoryItemId: 'a', qty: 0.5 }, { inventoryItemId: 'a', qty: 0.25 }], 2)
    expect(out).toEqual([{ inventoryItemId: 'a', qty: 1.5 }])
  })
  test('BATCH_STATUSES lifecycle constant', () => {
    expect([...BATCH_STATUSES]).toEqual(['DRAFT', 'COMPLETED', 'CANCELLED'])
  })
})

describe('batch: forecastQty', () => {
  test('ceil of the average (never under-prep)', () => {
    expect(forecastQty([2, 3])).toBe(3) // avg 2.5 → ceil 3
    expect(forecastQty([1.2, 1.2, 1.2])).toBe(2) // avg 1.2 → ceil 2
    expect(forecastQty([4])).toBe(4)
  })
  test('empty / all-invalid list → 0; negatives ignored; floor at 0', () => {
    expect(forecastQty([])).toBe(0)
    expect(forecastQty([-5, -1])).toBe(0)
    expect(forecastQty([-3, 4])).toBe(4) // negatives dropped, avg of positives
    expect(forecastQty(['x', null] as unknown as number[])).toBe(0)
  })
})

describe('batch: batchCostPerUnit', () => {
  test('4-dec rounding', () => {
    expect(batchCostPerUnit(10, 3)).toBe(3.3333)
    expect(batchCostPerUnit(1, 8)).toBe(0.125)
  })
  test('0 guards (totalInputCost <= 0, outputQuantity <= 0, NaN)', () => {
    expect(batchCostPerUnit(0, 5)).toBe(0)
    expect(batchCostPerUnit(-2, 5)).toBe(0)
    expect(batchCostPerUnit(10, 0)).toBe(0)
    expect(batchCostPerUnit(10, -1)).toBe(0)
    expect(batchCostPerUnit(Number.NaN, 2)).toBe(0)
  })
})

/* ─────────── B) ap-attachments.ts ─────────── */

describe('ap-attachments: base64ByteSize', () => {
  test('decoded byte size (PDF header fixture = 18 bytes)', () => {
    expect(base64ByteSize('JVBERi0xLjQKJcOkw7zDtsOf')).toBe(18)
    expect(base64ByteSize('')).toBe(0)
    expect(base64ByteSize(undefined)).toBe(0)
    expect(base64ByteSize('YQ==')).toBe(1) // 'a'
  })
})

describe('ap-attachments: sanitizeAttachments', () => {
  const pdfB64 = 'JVBERi0xLjQKJcOkw7zDtsOf' // 18 bytes decoded

  test('keeps payload when within budget; computes sizeB', () => {
    const out = sanitizeAttachments([{ mimeCode: 'application/pdf', filename: 'r.pdf', dataBase64: pdfB64 }])
    expect(out.truncated).toBe(false)
    expect(out.droppedBytes).toBe(0)
    expect(out.attachments).toEqual([{ mimeCode: 'application/pdf', filename: 'r.pdf', sizeB: 18, dataBase64: pdfB64 }])
  })

  test('budget exceeded → metadata only + truncated + droppedBytes', () => {
    const out = sanitizeAttachments(
      [
        { mimeCode: 'application/pdf', filename: 'small.pdf', dataBase64: pdfB64 },
        { mimeCode: 'application/pdf', filename: 'big.pdf', dataBase64: 'A'.repeat(100) }, // 75 bytes
      ],
      { maxTotalBase64Length: 50 },
    )
    expect(out.attachments[0].dataBase64).toBe(pdfB64)
    expect(out.attachments[1].dataBase64).toBeUndefined()
    expect(out.attachments[1].sizeB).toBe(75)
    expect(out.truncated).toBe(true)
    expect(out.droppedBytes).toBe(75)
  })

  test('max 5 attachments per AP (MAX_ATTACHMENTS_PER_AP)', () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({ filename: `f${i}.pdf`, dataBase64: pdfB64 }))
    const out = sanitizeAttachments(raw)
    expect(out.attachments.length).toBe(MAX_ATTACHMENTS_PER_AP)
    expect(out.attachments[0].filename).toBe('f0.pdf') // first ones survive
  })

  test('dedupe by filename + sizeB (first wins — idempotent re-import)', () => {
    const out = sanitizeAttachments([
      { filename: 'a.pdf', dataBase64: pdfB64 },
      { filename: 'a.pdf', dataBase64: pdfB64 },
      { filename: 'b.pdf', dataBase64: pdfB64 },
    ])
    expect(out.attachments.length).toBe(2)
    expect(out.attachments.map((a) => a.filename)).toEqual(['a.pdf', 'b.pdf'])
  })

  test('invalid/missing mime tolerated; missing payload → metadata-only entry', () => {
    const out = sanitizeAttachments([
      { mimeCode: 'weird/x-does-not-exist', filename: 'x.bin', dataBase64: pdfB64 },
      { filename: 'empty.pdf' },
      { dataBase64: '   ' },
    ])
    expect(out.attachments[0].mimeCode).toBe('weird/x-does-not-exist')
    expect(out.attachments[1].dataBase64).toBeUndefined()
    expect(out.attachments[1].sizeB).toBe(0)
    expect(out.attachments[2].dataBase64).toBeUndefined()
  })

  test('garbage input → empty result (never throws)', () => {
    expect(sanitizeAttachments(null).attachments).toEqual([])
    expect(sanitizeAttachments('nope').attachments).toEqual([])
    expect(sanitizeAttachments({ nope: 1 }).attachments).toEqual([])
    expect(sanitizeAttachments([null, 42, 'x', { filename: 'ok.pdf', dataBase64: pdfB64 }]).attachments.length).toBe(1)
  })

  test('oversizeNote formats MB with 1 decimal', () => {
    expect(oversizeNote(2 * 1024 * 1024)).toBe('(priloga 2.0 MB prevelika za arhiv v nastavitvah)')
    expect(oversizeNote(0)).toContain('0.0 MB')
  })

  test('default budget constant is 1.5 MB', () => {
    expect(MAX_TOTAL_BASE64_LENGTH).toBe(1_500_000)
  })
})

/* ─────────── C) recurring-po.ts reminder ─────────── */

const RULE_BASE = {
  id: 'r1',
  supplierId: 's1',
  items: [{ inventoryItemId: 'i1', qty: 2 }],
  weekdays: [1],
  hour: 8,
  everyWeeks: 1,
}

describe('recurring: remindMinutesBefore config', () => {
  test('default 60 for legacy rules without the field (additive, nothing breaks)', () => {
    const rules = parseRecurringConfig({ rules: [{ ...RULE_BASE, active: true, lastRun: null, nextRun: null }] })
    expect(rules[0].remindMinutesBefore).toBe(DEFAULT_REMIND_MINUTES_BEFORE)
  })
  test('valid value kept; string numbers accepted', () => {
    const rules = parseRecurringConfig({
      rules: [
        { ...RULE_BASE, id: 'a', active: true, lastRun: null, nextRun: null, remindMinutesBefore: 30 },
        { ...RULE_BASE, id: 'b', active: true, lastRun: null, nextRun: null, remindMinutesBefore: '120' },
      ],
    })
    expect(rules[0].remindMinutesBefore).toBe(30)
    expect(rules[1].remindMinutesBefore).toBe(120)
  })
  test('clamped to 0-1440; garbage → default 60', () => {
    const rules = parseRecurringConfig({
      rules: [
        { ...RULE_BASE, id: 'a', active: true, lastRun: null, nextRun: null, remindMinutesBefore: -5 },
        { ...RULE_BASE, id: 'b', active: true, lastRun: null, nextRun: null, remindMinutesBefore: 99999 },
        { ...RULE_BASE, id: 'c', active: true, lastRun: null, nextRun: null, remindMinutesBefore: 'soon' },
      ],
    })
    expect(rules[0].remindMinutesBefore).toBe(0)
    expect(rules[1].remindMinutesBefore).toBe(MAX_REMIND_MINUTES_BEFORE)
    expect(rules[2].remindMinutesBefore).toBe(DEFAULT_REMIND_MINUTES_BEFORE)
  })
  test('clampRemindMinutes edge cases', () => {
    expect(clampRemindMinutes(undefined)).toBeUndefined()
    expect(clampRemindMinutes(null)).toBeUndefined()
    expect(clampRemindMinutes('')).toBeUndefined()
    expect(clampRemindMinutes('abc')).toBeUndefined()
    expect(clampRemindMinutes(59.6)).toBe(60)
    expect(clampRemindMinutes(0)).toBe(0)
  })
})

describe('recurring: dueInMs / isRemindable', () => {
  const now = new Date('2026-02-11T10:00:00')

  test('dueInMs: positive until run, negative when overdue, Infinity without nextRun', () => {
    expect(dueInMs({ nextRun: '2026-02-11T11:00:00' }, now)).toBe(3600000)
    expect(dueInMs({ nextRun: '2026-02-11T09:00:00' }, now)).toBe(-3600000)
    expect(dueInMs({ nextRun: null }, now)).toBe(Number.POSITIVE_INFINITY)
    expect(dueInMs({ nextRun: 'garbage' }, now)).toBe(Number.POSITIVE_INFINITY)
  })

  test('lead window: due within remindMs → remindable (boundaries)', () => {
    const rule = { active: true, nextRun: '2026-02-11T11:00:00' }
    expect(isRemindable(rule, now, 3600000)).toBe(true) // exactly 60 min left
    expect(isRemindable(rule, now, 3599999)).toBe(false) // just outside the window
    expect(isRemindable({ active: true, nextRun: '2026-02-11T13:00:00' }, now, 3600000)).toBe(false)
  })

  test('overdue: remindable only within the 60-min anti-spam window', () => {
    expect(isRemindable({ active: true, nextRun: '2026-02-11T09:45:00' }, now, 3600000)).toBe(true) // 15 min overdue
    expect(isRemindable({ active: true, nextRun: '2026-02-11T10:00:00' }, now, 3600000)).toBe(true) // due exactly now
    expect(isRemindable({ active: true, nextRun: '2026-02-11T08:45:00' }, now, 3600000)).toBe(false) // 75 min overdue — stop nagging
  })

  test('inactive rules and missing nextRun never remind', () => {
    expect(isRemindable({ active: false, nextRun: '2026-02-11T11:00:00' }, now, 3600000)).toBe(false)
    expect(isRemindable({ active: true, nextRun: null }, now, 3600000)).toBe(false)
  })

  test('zero remindMs → only overdue branch applies', () => {
    expect(isRemindable({ active: true, nextRun: '2026-02-11T11:00:00' }, now, 0)).toBe(false)
    expect(isRemindable({ active: true, nextRun: '2026-02-11T09:30:00' }, now, 0)).toBe(true)
  })
})

describe('recurring: dueTodayRules (digest section)', () => {
  const now = new Date('2026-02-11T10:00:00')
  const rules = [
    { id: 'today', active: true, nextRun: '2026-02-11T08:00:00' },
    { id: 'tomorrow', active: true, nextRun: '2026-02-12T08:00:00' },
    { id: 'inactive', active: false, nextRun: '2026-02-11T09:00:00' },
    { id: 'noRun', active: true, nextRun: null },
  ]
  test('same local day only, active only, missing nextRun skipped', () => {
    expect(dueTodayRules(rules, now).map((r) => r.id)).toEqual(['today'])
  })
  test('empty / garbage input → []', () => {
    expect(dueTodayRules([], now)).toEqual([])
    expect(dueTodayRules(rules as never, 'not-a-date')).toEqual([])
  })
})

/* ─────────── D) eslog.ts attachments ─────────── */

const XML_WITH_ATTACHMENT = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <cbc:ID>2026-42</cbc:ID>
  <cbc:IssueDate>2026-02-10</cbc:IssueDate>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Dobavitelj d.o.o.</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme><cbc:CompanyID>SI12345678</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AdditionalDocumentReference>
    <cbc:ID>VisualInvoice</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="racun-42.pdf">JVBERi0xLjQKJcOkw7zDtsOf</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>Extra</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/xml" filename="dodatek.xml">PG5vdGU+MTIzPC9ub3RlPg==</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount>100.00</cbc:TaxExclusiveAmount>
    <cbc:PayableAmount>122.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`

const XML_NO_ATTACHMENT = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <cbc:ID>2026-43</cbc:ID>
  <cbc:IssueDate>2026-02-10</cbc:IssueDate>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Drugi d.o.o.</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme><cbc:CompanyID>SI87654321</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount>50.00</cbc:TaxExclusiveAmount>
    <cbc:PayableAmount>61.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
</Invoice>`

describe('eslog: attachment extraction', () => {
  test('extracts multiple attachments with mimeCode + filename (base64 preserved)', () => {
    const { invoice, error } = parseEslog(XML_WITH_ATTACHMENT)
    expect(error).toBeNull()
    expect(invoice).not.toBeNull()
    expect(invoice!.attachments.length).toBe(2)
    expect(invoice!.attachments[0]).toEqual({
      mimeCode: 'application/pdf',
      filename: 'racun-42.pdf',
      dataBase64: 'JVBERi0xLjQKJcOkw7zDtsOf',
    })
    expect(invoice!.attachments[1].mimeCode).toBe('text/xml')
    expect(invoice!.attachments[1].filename).toBe('dodatek.xml')
  })

  test('absent attachment → attachments: [] (never fails the parse)', () => {
    const { invoice, error } = parseEslog(XML_NO_ATTACHMENT)
    expect(error).toBeNull()
    expect(invoice!.attachments).toEqual([])
  })

  test('Attachment without a binary object is skipped; invoice core fields intact', () => {
    const xml = XML_NO_ATTACHMENT.replace(
      '<cac:LegalMonetaryTotal>',
      '<cac:AdditionalDocumentReference><cac:Attachment><cbc:EmbeddedDocumentBinaryObject></cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cac:LegalMonetaryTotal>',
    )
    const { invoice } = parseEslog(xml)
    expect(invoice!.attachments).toEqual([])
    expect(invoice!.invoiceNumber).toBe('2026-43')
  })
})
