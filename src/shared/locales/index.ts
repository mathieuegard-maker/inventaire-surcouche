// src/shared/locales/index.ts
// Helper i18n strictement typé sur les clés imbriquées de `fr.ts`.

import { fr, type LocaleDictionary } from './fr';
import type { LocaleId } from '../types/domain.types';

type NestedKeyOf<ObjectType extends Record<string, unknown>> = {
  [Key in keyof ObjectType & string]: ObjectType[Key] extends Record<string, unknown>
    ? `${Key}.${NestedKeyOf<ObjectType[Key]>}`
    : Key;
}[keyof ObjectType & string];

export type TranslationKey = NestedKeyOf<LocaleDictionary>;

const DICTIONARIES: Record<LocaleId, Record<string, unknown>> = {
  fr
};

let activeLocale: LocaleId = 'fr';

export function setLocale(locale: LocaleId): void {
  activeLocale = locale;
}

export function getLocale(): LocaleId {
  return activeLocale;
}

function resolveKey(dict: Record<string, unknown>, key: string): string {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return key;
    }
  }
  return typeof cur === 'string' ? cur : key;
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const dict = DICTIONARIES[activeLocale] ?? DICTIONARIES.fr;
  let value = resolveKey(dict, key);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      value = value.replaceAll(`{${k}}`, String(v));
    }
  }
  return value;
}

export { fr };
