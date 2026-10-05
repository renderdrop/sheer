import { isPlainKey, type Translate } from '../../i18n';

/** What a step's texts take from `steps.json`: the thumbnail positions of Reorder (`{from}`, `{to}`). */
export interface StepTextSource {
  id: string;
  from?: number;
  to?: number;
}

/** The title and the instruction of a step, from the `tour.step.<id>.*` messages (the welcome document uses the same ones). */
export function stepText(
  t: Translate,
  step: StepTextSource | undefined,
  extra: { mod?: string } = {},
): { title: string; text: string } {
  const id = step?.id ?? '';
  const title = `tour.step.${id}.title`;
  const text = `tour.step.${id}.text`;
  const params = { from: step?.from ?? 0, to: step?.to ?? 0, mod: extra.mod ?? '' };
  return { title: isPlainKey(title) ? t(title) : '', text: isPlainKey(text) ? t(text, params) : '' };
}
