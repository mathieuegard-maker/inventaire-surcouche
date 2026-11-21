// src/core/bibliographic/intermarc-parser.ts
// Parseur XML InterMarc BnF unifié (seule source de vérité partagée entre bnf.resolver, v4-pipeline et d1-gateway).

export interface MarcSubfield {
  code: string;
  value: string;
}

export interface MarcField {
  tag: string;
  subfields: MarcSubfield[];
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Parseur d'enregistrements InterMarc / MarcXchange XML en champs et sous-zones structurés.
 * Accepte indifféremment les balises préfixées (`<mxc:datafield>`) ou non préfixées (`<datafield>`).
 */
export function parseMarcFields(xml: string): MarcField[] {
  const fields: MarcField[] = [];
  const dfRegex = /<(?:[\w-]+:)?datafield\s+[^>]*tag="(\d+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?datafield>/gi;
  let dfMatch: RegExpExecArray | null;
  while ((dfMatch = dfRegex.exec(xml)) !== null) {
    const tag = dfMatch[1];
    const inner = dfMatch[2];
    const subfields: MarcSubfield[] = [];
    const sfRegex = /<(?:[\w-]+:)?subfield\s+[^>]*code="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?subfield>/gi;
    let sfMatch: RegExpExecArray | null;
    while ((sfMatch = sfRegex.exec(inner)) !== null) {
      subfields.push({
        code: sfMatch[1],
        value: decodeXmlEntities(sfMatch[2])
      });
    }
    fields.push({ tag, subfields });
  }
  return fields;
}

/**
 * Extrait la valeur de la première sous-zone correspondant à `code` dans un champ MARC.
 */
export function getSubfield(field: MarcField, code: string): string | undefined {
  const sf = field.subfields.find((s) => s.code === code);
  return sf ? sf.value : undefined;
}

/**
 * Extrait un champ de contrôle MARC (ex: `008`) avec ou sans préfixe XML.
 */
export function extractControlField(xml: string, tag: string): string {
  const match = new RegExp(
    `<(?:[\\w-]+:)?controlfield\\s+[^>]*tag="${tag}"[^>]*>([^<]*)<\\/(?:[\\w-]+:)?controlfield>`,
    'i'
  ).exec(xml);
  return match ? match[1] : '';
}

/**
 * Extrait l'identifiant d'image de couverture BnF (`950$a`) depuis un fragment XML InterMarc.
 */
export function extractBnfCoverId(xml: string): string | null {
  const tag950Regex = /<(?:[\w-]+:)?datafield\s+[^>]*tag="950"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?datafield>/i;
  const match950 = tag950Regex.exec(xml);
  if (!match950) return null;

  const subfieldARegex = /<(?:[\w-]+:)?subfield\s+[^>]*code="a"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?subfield>/i;
  const matchSubfieldA = subfieldARegex.exec(match950[1]);
  return matchSubfieldA ? matchSubfieldA[1].trim() : null;
}
