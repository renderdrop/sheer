import { isPlainKey, type Translate } from '../../i18n';

/** The title and the instruction of a step, from the `tour.step.<id>.*` messages (the welcome document uses the same ones). */
export function stepText(t: Translate, id: string): { title: string; text: string } {
  const title = `tour.step.${id}.title`;
  const text = `tour.step.${id}.text`;
  return { title: isPlainKey(title) ? t(title) : '', text: isPlainKey(text) ? t(text) : '' };
}
