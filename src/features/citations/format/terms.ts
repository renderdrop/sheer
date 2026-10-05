import type { Lang } from './text';

/** Words that follow the UI language. */
export interface Terms {
  p: string;
  pp: string;
  vol: string;
  no: string;
  etAl: string;
  and: string;
  nd: string;
  thesis: string;
  accessed: string;
  retrieved: (date: string, url: string) => string;
  available: string;
}

export const TERMS: Record<Lang, Terms> = {
  en: {
    p: 'p.',
    pp: 'pp.',
    vol: 'vol.',
    no: 'no.',
    etAl: 'et al.',
    and: 'and',
    nd: 'n.d.',
    thesis: 'Thesis',
    accessed: 'Accessed',
    retrieved: (date, url) => (date === '' ? url : `Retrieved ${date}, from ${url}`),
    available: 'Available from:',
  },
  de: {
    p: 'S.',
    pp: 'S.',
    vol: 'Bd.',
    no: 'Nr.',
    etAl: 'u. a.',
    and: 'und',
    nd: 'o. J.',
    thesis: 'Abschlussarbeit',
    accessed: 'Abgerufen am',
    retrieved: (date, url) => (date === '' ? url : `Abgerufen am ${date} von ${url}`),
    available: 'Verfügbar unter:',
  },
};
