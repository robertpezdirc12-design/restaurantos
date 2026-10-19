/**
 * Lokalni čas za fiskalne dokumente (audit 2026-10 #2, v1.143.0).
 *
 * FURS spec 1.13 in HR Fiskalizacija 2.0 v kanoničnem nizu in v SOAP polju
 * `IssueDateTime`/`DatVrijeme` zahtevata LOKALNI čas izdaje v obliki
 * `yyyy-MM-ddTHH:mm:ss` (oziroma `d.M.yyyy HH:mm:ss`), ne UTC in ne ISO z
 * končnico `Z` ali milisekundami. Strežnik (Vercel) teče v UTC-ju, zato je
 * bil račun izdan 01:30 lokalno oddan kot prejšnji dan 23:30 — napačen
 * obračunski dan pri FURS in številka računa (`leto-mesec-…`) v razkoraku s
 * poslanim datumom.
 *
 * Ena sama točka branja (`localParts`) sme brati koledarske dele; vse ostalo
 * se izgradi iz njih, da formatting in številčenje ne moreta zaiti.
 */

export interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const FALLBACK_TZ = 'Europe/Ljubljana'

/** Koledarski deli datuma v podani coni.
 *  - cona podana in veljavna → ta cona (pravilno: lokalni čas lokacije);
 *  - cona podana a neveljavna (tipkanje v nastavitvah lokacije) → Europe/Ljubljana,
 *    NE sistemski čas — sicer bi bil račun spet oddan v UTC;
 *  - cona NI podana → sistemski lokalni čas (obstoječe vedenje, nazaj-kompatibilno).
 *  Nikoli ne vrže: fiskalna izdaja ne sme pasti zaradi formata nastavitve. */
export function localParts(date: Date, timeZone?: string | null): LocalParts {
  const read = (zone?: string): LocalParts | null => {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        ...(zone ? { timeZone: zone } : {}),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(date)
      const get = (type: Intl.DateTimeFormatPartTypes): number => {
        const raw = parts.find((p) => p.type === type)?.value ?? ''
        const n = parseInt(raw, 10)
        return Number.isFinite(n) ? n : 0
      }
      return {
        year: get('year'),
        month: get('month'),
        day: get('day'),
        hour: get('hour') % 24, // nekatere ICU različice vrnejo '24' za polnoč
        minute: get('minute'),
        second: get('second'),
      }
    } catch {
      return null
    }
  }
  const tz = (timeZone || '').trim()
  if (!tz) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    }
  }
  return read(tz) || read(FALLBACK_TZ) || read() || {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  }
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** 'YYYY-MM-DDTHH:mm:ss' v lokalnem času — FURS `IssueDateTime` in ZOI niz. */
export function isoLocal(date: Date, timeZone?: string | null): string {
  const l = localParts(date, timeZone)
  return `${l.year}-${p2(l.month)}-${p2(l.day)}T${p2(l.hour)}:${p2(l.minute)}:${p2(l.second)}`
}

/** 'dd.MM.yyyy HH:mm:ss' — HR ZKI kanonični niz (Fiskalizacija 2.0).
 *  Ničlo-padded dan in mesec (pinned s tests/cis-client.test.ts). */
export function hrLocalDateTime(date: Date, timeZone?: string | null): string {
  const l = localParts(date, timeZone)
  return `${p2(l.day)}.${p2(l.month)}.${l.year} ${p2(l.hour)}:${p2(l.minute)}:${p2(l.second)}`
}

/** 'dd.MM.yyyyTHH:mm:ss' — HR SOAP `DatumVrijeme`/`DatVrijeme`. */
export function hrLocalDateTimeT(date: Date, timeZone?: string | null): string {
  const l = localParts(date, timeZone)
  return `${p2(l.day)}.${p2(l.month)}.${l.year}T${p2(l.hour)}:${p2(l.minute)}:${p2(l.second)}`
}

/** Lokalni koledarski mesec izdaje (`leto`, `mesec`) — za številko računa. */
export function localYearMonth(date: Date, timeZone?: string | null): { y: number; m: number } {
  const l = localParts(date, timeZone)
  return { y: l.year, m: l.month }
}
