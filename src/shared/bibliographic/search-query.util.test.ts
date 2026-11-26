// src/shared/bibliographic/search-query.util.test.ts
import { describe, expect, it } from 'vitest';
import { parseSearchIntent } from './search-query.util';

describe('search-query.util (parseSearchIntent)', () => {
  it('extrait le média entre parenthèses et le numéro de tome collé dans le titre', () => {
    const res1 = parseSearchIntent({ title: 'La Horde du Contrevent (BD) Tome 1' });
    expect(res1.requestedMedia).toBe('BD');
    expect(res1.cleanTitle).toBe('La Horde du Contrevent');
    expect(res1.volumeNumber).toBe('1');
    expect(res1.volumeNumeric).toBe(1);

    const res2 = parseSearchIntent({ title: 'Arsène Lupin (manga Kurokawa) Tome 1' });
    expect(res2.requestedMedia).toBe('Manga');
    expect(res2.cleanTitle).toBe('Arsène Lupin');
    expect(res2.volumeNumber).toBe('1');
    expect(res2.effectivePublisher).toBe('Kurokawa');
    expect(res2.editionHintTokens).toContain('kurokawa');

    const res3 = parseSearchIntent({ title: 'The Witcher - La Maison de verre (comics) Tome 1' });
    expect(res3.requestedMedia).toBe('Comics');
    expect(res3.cleanTitle).toBe('The Witcher - La Maison de verre');
    expect(res3.volumeNumber).toBe('1');

    const res4 = parseSearchIntent({ title: 'Le Petit Prince (BD)', author: 'Joann Sfar' });
    expect(res4.requestedMedia).toBe('BD');
    expect(res4.cleanTitle).toBe('Le Petit Prince');
    expect(res4.volumeNumber).toBeNull();
  });

  it('extrait les abréviations tN, Tome N, T.N et chiffres romains sans altérer 1984 ou PH10', () => {
    const blast = parseSearchIntent({ title: 'Blast Tome II', author: 'Manu Larcenet' });
    expect(blast.cleanTitle).toBe('Blast');
    expect(blast.volumeNumber).toBe('2');

    const ass = parseSearchIntent({ title: 'Assassination Classroom Tome 19' });
    expect(ass.cleanTitle).toBe('Assassination Classroom');
    expect(ass.volumeNumber).toBe('19');

    const clans = parseSearchIntent({ title: 'la guerre des clans t1', author: 'Hunter' });
    expect(clans.cleanTitle).toBe('la guerre des clans');
    expect(clans.volumeNumber).toBe('1');

    const orwell = parseSearchIntent({ title: '1984', author: 'George Orwell' });
    expect(orwell.cleanTitle).toBe('1984');
    expect(orwell.volumeNumber).toBeNull();

    const herme = parseSearchIntent({ title: 'ph10 patisserie', author: 'pierre herme' });
    expect(herme.cleanTitle).toBe('ph10 patisserie');
    expect(herme.volumeNumber).toBeNull();
  });

  it('relâche les qualificatifs éditoriaux uniquement dans relaxedTitle tout en les gardant pour le scoring', () => {
    const bleach = parseSearchIntent({ title: 'bleach deluxe t2', publisher: 'Glenat' });
    expect(bleach.volumeNumber).toBe('2');
    expect(bleach.cleanTitle).toBe('bleach deluxe');
    expect(bleach.relaxedTitle).toBe('bleach');
    expect(bleach.editionHintTokens).toContain('deluxe');

    const deathNote = parseSearchIntent({ title: 'death note black edition tome 3' });
    expect(deathNote.volumeNumber).toBe('3');
    expect(deathNote.relaxedTitle).toBe('death note');
    expect(deathNote.editionHintTokens).toContain('black');

    const gunnm = parseSearchIntent({ title: 'gunnm grand format glénat t2', publisher: 'Glénat' });
    expect(gunnm.volumeNumber).toBe('2');
    expect(gunnm.relaxedTitle).toBe('gunnm');
    expect(gunnm.editionHintTokens).toContain('glenat');
  });

  it('extrait proprement les intégrales, coffrets, plages T.1-3 et titres inline Série - Tome N : Sous-titre', () => {
    const vf = parseSearchIntent({ title: "Les Vieux Fourneaux - L'intégrale T.1-3" });
    expect(vf.wantsIntegral).toBe(true);
    expect(vf.integralRange).toEqual(['1', '2', '3']);
    expect(vf.integralSeriesBase).toBe('Les Vieux Fourneaux');

    const murena = parseSearchIntent({ title: "Murena - L'intégrale Cycle des mères (T.1-4)" });
    expect(murena.wantsIntegral).toBe(true);
    expect(murena.integralRange).toEqual(['1', '2', '3', '4']);
    expect(murena.integralSeriesBase).toBe('Murena');

    const undertaker = parseSearchIntent({ title: 'Undertaker - Intégrale Tomes 1 & 2' });
    expect(undertaker.wantsIntegral).toBe(true);
    expect(undertaker.integralRange).toEqual(['1', '2']);
    expect(undertaker.integralSeriesBase).toBe('Undertaker');

    const fleau = parseSearchIntent({ title: "Le Fléau - Tome 1 : L'Épidémie" });
    expect(fleau.cleanSeries).toBe('Le Fléau');
    expect(fleau.cleanTitle).toBe("L'Épidémie");
    expect(fleau.volumeNumber).toBe('1');

    const mill = parseSearchIntent({
      title: 'Millénium Saga - Tome 3',
      series: 'Millénium Saga (BD)',
      volumeNumber: '3'
    });
    expect(mill.requestedMedia).toBe('BD');
    expect(mill.cleanSeries).toBe('Millénium Saga');
    expect(mill.cleanTitle).toBe('Millénium Saga');
    expect(mill.volumeNumber).toBe('3');
  });
});
