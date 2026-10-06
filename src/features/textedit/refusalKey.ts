import type { PlainKey } from '../../i18n';
import type { Refusal } from './store';

/** The tooltip text of a refusal (DESIGN 3.10 E5): every `TextEditRefusal` word and `noText` has one. */
export function refusalKey(reason: Refusal['reason']): PlainKey {
  switch (reason) {
    case 'invisible':
      return 'editText.refuse.ocr';
    case 'type3':
      return 'editText.refuse.type3';
    case 'vertical':
      return 'editText.refuse.rotated';
    case 'cmap':
    case 'unmapped':
      return 'editText.refuse.encoding';
    case 'clip':
      return 'editText.refuse.clip';
    case 'inForm':
      return 'editText.refuse.inForm';
    case 'actualText':
      return 'editText.refuse.actualText';
    case 'script':
      return 'editText.refuse.script';
    case 'notFileSource':
      return 'editText.refuse.notFileSource';
    case 'tooComplex':
      return 'editText.refuse.tooComplex';
    case 'signed':
      return 'cert.locked.tool';
    case 'permission':
      return 'tool.readOnly';
    case 'noText':
      return 'editText.noText';
  }
}
