/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * A small SAX-style XML scanner, enough for the SpreadsheetML parts: open
 * and close tags with their attributes, and text, in document order, with
 * no tree built. Namespaces are kept as written (`x:c` is not `c`): the
 * callers strip prefixes with `local`.
 *
 * @module xlsx/xml
 */

const TOKEN =
  /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|([^<]+)/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export type Attributes = Record<string, string>;

export interface XmlHandler {
  open?(name: string, attributes: Attributes, selfClosing: boolean): void;
  close?(name: string): void;
  text?(text: string): void;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text with its entities decoded. */
export function decode(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

/** Text for XML: `<`, `>`, `&` and quotes escaped. */
export function escape(text: string): string {
  return text.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  );
}

/** A name without its namespace prefix. */
export const local = (name: string) => {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

function attributes(raw: string): Attributes {
  const out: Attributes = {};
  if (raw === '') return out;
  ATTRIBUTE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTRIBUTE.exec(raw)) !== null) out[local(m[1])] = decode(m[2] ?? m[3] ?? '');
  return out;
}

/** Scan a part, telling the handler each tag and text. */
export function scan(xml: string, handler: XmlHandler): void {
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(xml)) !== null) {
    if (m[2] !== undefined) {
      const name = local(m[2]);
      if (m[1] === '/') handler.close?.(name);
      else {
        const self = m[4] === '/';
        handler.open?.(name, attributes(m[3]), self);
        if (self) handler.close?.(name);
      }
    } else if (m[5] !== undefined) handler.text?.(m[5]);
    else if (m[6] !== undefined) handler.text?.(decode(m[6]));
  }
}
