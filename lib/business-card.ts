// lib/business-card.ts
// Turns the recognized text of a business card into contact fields. Phone
// numbers, emails, links and the address come from data detection
// (lib/text-actions); the name, company and job title from the layout and a
// few keyword rules: the name is the most prominent line that is neither
// contact data, a company nor a title. The user reviews everything in the
// system New Contact form before anything is saved.
import type { OcrLine } from './ocr';
import type { ContactFields, DetectedData } from './text-actions';

export type CardEntities = { people?: string[]; organizations?: string[] };

export type ParsedCard = {
  fields: ContactFields;
  /** "Sarah Mitchell", else the company, else null. */
  displayName: string | null;
};

const COMPANY_RE =
  /\b(ltd|limited|inc|incorporated|llc|llp|gmbh|corp|corporation|company|co\.|plc|pty|s\.?a\.?r\.?l|s\.?a\.?s|s\.?a\.|s\.?p\.?a|b\.?v\.|ag|kg|group|holdings|studio|studios|labs?|partners|associates|consulting|solutions|technologies|technology|systems|agency|bank|university|institute|clinic|hospital|foundation)\b/i;
const TITLE_RE =
  /\b(manager|director|engineer|designer|developer|ceo|cto|cfo|coo|cmo|founder|co-founder|president|officer|consultant|head|lead|partner|specialist|analyst|architect|sales|marketing|assistant|associate|advisor|adviser|vp|vice president|owner|attorney|lawyer|counsel|professor|coordinator|representative|executive|accountant|agent|chef|nurse|physician|surgeon|dentist|editor|producer|photographer|recruiter|administrator|secretary|treasurer|chair|chairman|principal|intern|technician|supervisor|directeur|directrice|gérant|ingénieur|responsable|chargée?|conseill[eè]re?)\b/i;
const NAME_PREFIX_RE = /^(dr|mr|mrs|ms|miss|prof|mx|me|mme|m)\.?$/i;
const MOBILE_RE = /\b(mobile|mob|cell|cellular|portable|handy|m)\b\s*[:.]?\s*$/i;
const FAX_RE = /\b(fax|f)\b\s*[:.]?\s*$/i;

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Lines in reading order: top to bottom, then left to right. */
function ordered(lines: OcrLine[]): OcrLine[] {
  return [...lines].filter(l => clean(l.text)).sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Whether `line` is (part of) a detected item, so it isn't a name or company. */
function isDataLine(line: string, found: DetectedData[]): boolean {
  const l = clean(line).toLowerCase();
  if (!l) return false;
  return found.some(d => {
    const t = clean(d.text).toLowerCase();
    if (!t) return false;
    if (l.includes(t) || t.includes(l)) return true;
    return false;
  });
}

function looksLikeName(s: string): boolean {
  const words = s.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (/[\d@/\\:;|_=+#%&*<>]/.test(s)) return false;
  // Names are mostly letters, each word starting with a capital (or all caps).
  const letters = s.replace(/[^\p{L}]/gu, '').length;
  if (letters < s.replace(/\s/g, '').length * 0.8) return false;
  return words.every(w => /^\p{Lu}/u.test(w) || NAME_PREFIX_RE.test(w) || /^(de|da|del|der|van|von|di|du|la|le|bin|al|el)$/i.test(w));
}

function titleCase(s: string): string {
  // "SARAH MITCHELL" → "Sarah Mitchell"; mixed case is kept as printed.
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase());
}

/** Splits a printed name into contact name parts. */
export function splitName(full: string): Pick<ContactFields, 'namePrefix' | 'givenName' | 'middleName' | 'familyName' | 'nameSuffix'> {
  const words = titleCase(clean(full)).split(' ').filter(Boolean);
  const out: ReturnType<typeof splitName> = {};
  if (words.length && NAME_PREFIX_RE.test(words[0]) && words.length > 1) out.namePrefix = words.shift();
  if (words.length > 1 && /^(jr|sr|ii|iii|iv|phd|md|mba)\.?$/i.test(words[words.length - 1].replace(/,$/, ''))) {
    out.nameSuffix = words.pop();
  }
  if (words.length === 1) {
    out.givenName = words[0];
  } else if (words.length >= 2) {
    out.givenName = words[0];
    // Particles belong to the family name: "Ludwig van Beethoven".
    let i = words.length - 1;
    while (i > 1 && /^(de|da|del|der|van|von|di|du|la|le|bin|al|el)$/i.test(words[i - 1])) i--;
    out.familyName = words.slice(i).join(' ');
    if (i > 1) out.middleName = words.slice(1, i).join(' ');
  }
  return out;
}

export function parseBusinessCard(lines: OcrLine[], found: DetectedData[], entities: CardEntities = {}): ParsedCard {
  const rows = ordered(lines);
  const fields: ContactFields = {};

  // ── Contact data ─────────────────────────────────────────────────────────
  const phones: NonNullable<ContactFields['phones']> = [];
  for (const d of found.filter(x => x.type === 'phone')) {
    const row = rows.find(r => r.text.includes(d.text));
    const before = row ? row.text.slice(0, row.text.indexOf(d.text)) : '';
    const label = MOBILE_RE.test(before) ? 'mobile' : FAX_RE.test(before) ? 'fax' : 'work';
    if (!phones.some(p => p.number.replace(/\D/g, '') === d.value.replace(/\D/g, ''))) phones.push({ number: clean(d.value), label });
  }
  if (phones.length) fields.phones = phones;

  const emails = [...new Set(found.filter(d => d.type === 'email').map(d => d.value.toLowerCase()))];
  if (emails.length) fields.emails = emails;

  const urls = [...new Set(found.filter(d => d.type === 'url').map(d => d.value))];
  if (urls.length) fields.urls = urls;

  const addresses = found
    .filter(d => d.type === 'address')
    .map(d => {
      const a = d.address ?? {};
      if (a.street || a.city || a.postalCode) {
        return { street: a.street, city: a.city, state: a.state, postalCode: a.postalCode, country: a.country };
      }
      return { street: clean(d.text) };
    });
  if (addresses.length) fields.addresses = addresses.slice(0, 2);

  // ── Name, company, title ────────────────────────────────────────────────
  const free = rows.filter(r => !isDataLine(r.text, found));
  const orgs = (entities.organizations ?? []).map(o => o.toLowerCase());
  const people = (entities.people ?? []).map(p => p.toLowerCase());

  const companyRow =
    free.find(r => orgs.some(o => clean(r.text).toLowerCase().includes(o))) ??
    free.find(r => COMPANY_RE.test(r.text) && !TITLE_RE.test(r.text));
  if (companyRow) fields.organizationName = clean(companyRow.text);

  const titleRow = free.find(r => r !== companyRow && TITLE_RE.test(r.text) && !/[@\d]{3,}/.test(r.text));
  if (titleRow) fields.jobTitle = clean(titleRow.text);

  const candidates = free.filter(r => r !== companyRow && r !== titleRow && looksLikeName(clean(r.text)));
  const byEntity = candidates.find(r => people.some(p => clean(r.text).toLowerCase().includes(p)));
  // The most prominent line (largest type), the higher one on a tie.
  const byLayout = [...candidates].sort((a, b) => b.height - a.height || a.top - b.top)[0];
  const nameRow = byEntity ?? byLayout;
  if (nameRow) Object.assign(fields, splitName(nameRow.text));

  const person = [fields.givenName, fields.middleName, fields.familyName].filter(Boolean).join(' ');
  return { fields, displayName: person || fields.organizationName || null };
}

/** Document name for a saved card: "Business card – Sarah Mitchell". */
export function businessCardDocName(displayName: string | null, fallback: string): string {
  const name = clean(displayName ?? '').slice(0, 60);
  return name ? `Business card – ${name}` : fallback;
}

/** Whether a parse found anything worth putting in a contact. */
export function hasContactData(f: ContactFields): boolean {
  return !!(
    f.givenName ||
    f.familyName ||
    f.organizationName ||
    f.phones?.length ||
    f.emails?.length ||
    f.urls?.length ||
    f.addresses?.length
  );
}
