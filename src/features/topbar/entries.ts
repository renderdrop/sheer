import type { MenuEntry, MenuItemSpec } from '../../components';
import { runAction } from '../../actions/dispatch';
import { actionOf, actionShortcut, type ActionId } from '../../actions/registry';
import type { ActionState } from '../../actions/state';
import type { Platform } from '../../api/app';
import type { Translate } from '../../i18n';
import { formatZoomStatus } from './format';

export interface EntryContext {
  t: Translate;
  platform: Platform | null;
  state: ActionState;
}

/** A menu item that runs a registry action: its name, icon, shortcut and enabled state are the action's. */
export function commandEntry(id: ActionId, ctx: EntryContext, extra: Partial<MenuItemSpec> = {}): MenuItemSpec {
  const action = actionOf(id);
  const shortcut = actionShortcut(action, ctx.platform, ctx.t);
  return {
    id,
    label: ctx.t(action.labelKey),
    icon: action.icon,
    shortcut: shortcut?.label,
    disabled: !action.enabled(ctx.state),
    onSelect: () => void runAction(id),
    ...extra,
  };
}

const separator = (id: string, label?: string): MenuEntry => ({ type: 'separator', id, label });

/** The zoom menu: steps and fits, then the scroll modes and the view rotation under their own headings. */
export function zoomEntries(ctx: EntryContext, scrollMode: string): MenuEntry[] {
  const scroll = (id: 'scroll-continuous' | 'scroll-single' | 'scroll-spread') =>
    commandEntry(id, ctx, { checked: scrollMode === id.slice('scroll-'.length), icon: undefined });
  return [
    commandEntry('zoom-in', ctx),
    commandEntry('zoom-out', ctx),
    commandEntry('actual-size', ctx, { label: formatZoomStatus(1, ctx.t.locale) }),
    commandEntry('fit-width', ctx),
    commandEntry('fit-page', ctx),
    separator('zoom-sep-scroll', ctx.t('topbar.section.scroll')),
    scroll('scroll-continuous'),
    scroll('scroll-single'),
    scroll('scroll-spread'),
    separator('zoom-sep-rotate', ctx.t('topbar.section.rotate')),
    commandEntry('rotate-view-right', ctx),
    commandEntry('rotate-view-left', ctx),
    commandEntry('rotate-view-reset', ctx),
  ];
}
