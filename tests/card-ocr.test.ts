// Real OCR on real pictures (sample cards drawn in a browser): the engine is the one the sign-up screen ships.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { readCardText } from '../src/lib/cardOcr.ts';
import { compareCard, compareName, compareSession, comparePrograms, compareCampus, describeCheck, hasMismatch } from '../shared/card-match.ts';

const require = createRequire(import.meta.url);
const paths = {
  workerPath: join(dirname(require.resolve('tesseract.js/package.json')), 'src/worker-script/node/index.js'),
  corePath: dirname(require.resolve('tesseract.js-core/package.json')),
  langPath: join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0'),
};
const img = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
const typed = { name: 'Ayesha Khan', campusName: 'Allama Iqbal Town Campus', program: 'fsc_pre_medical', session: '2024-2026' };

let okText = '';
let otherText = '';
beforeAll(async () => {
  okText = await readCardText(img('card-ok.png'), paths, 120000);
  otherText = await readCardText(img('card-other.png'), paths, 120000);
}, 240000);

describe('reading a card with OCR', () => {
  it('reads the printed fields', () => {
    expect(okText.toLowerCase()).toContain('ayesha');
    expect(okText).toContain('2024');
  });

  it('every typed field matches the card it came from', () => {
    expect(compareCard(okText, typed)).toEqual({ name: 'match', campus: 'match', program: 'match', session: 'match' });
  });

  it("someone else's card is flagged, field by field, and never auto-corrected", () => {
    const c = compareCard(otherText, typed);
    expect(c.name).toBe('mismatch');
    expect(c.session).toBe('mismatch');
    expect(c.program).toBe('mismatch');
    expect(hasMismatch(c)).toBe(true);
    expect(describeCheck(c).check).toEqual(expect.arrayContaining(['name', 'program', 'session']));
  });

  it('a single misread letter in the name is tolerated, two different people are not', () => {
    expect(compareName(okText.replace('Ayesha', 'Ayeshn'), typed.name)).toBe('match');
    expect(compareName(okText, 'Zainab Siddiqui')).toBe('mismatch');
  });

  it('garbage or empty text is "unreadable", never a mismatch', () => {
    for (const t of ['', '   ', '|| .. ~~ ## 12']) {
      expect(compareCard(t, typed)).toEqual({ name: 'unreadable', campus: 'unreadable', program: 'unreadable', session: 'unreadable' });
    }
  });
});

describe('comparison rules', () => {
  const long = 'sample student card lahore campus name ayesha khan program medical session 2024-26 roll number';
  it('sessions: long form, short form, one year only, other years', () => {
    expect(compareSession(long.replace('2024-26', '2024 - 2026'), '2024-2026')).toBe('match');
    expect(compareSession(long, '2024-2026')).toBe('match');
    expect(compareSession(long.replace('2024-26', '2024'), '2024-2026')).toBe('uncertain');
    expect(compareSession(long.replace('2024-26', '2020-22'), '2024-2026')).toBe('mismatch');
    expect(compareSession(long.replace('2024-26', '2022-2024'), '2024-2026')).toBe('mismatch');
  });
  it('programs: a lone "fa" is weak evidence and cannot make a match', () => {
    expect(comparePrograms(long, 'fsc_pre_medical')).toBe('match');
    expect(comparePrograms(long, 'fsc_pre_engineering')).toBe('mismatch');
    expect(comparePrograms(long.replace('medical', 'fa'), 'fa')).toBe('uncertain');
    expect(comparePrograms(long.replace('medical', 'commerce'), 'icom')).toBe('match');
  });
  it('campus ignores filler words', () => {
    expect(compareCampus(long, 'Government Lahore Campus')).toBe('match');
    expect(compareCampus(long, 'Multan Campus')).toBe('mismatch');
  });
});
