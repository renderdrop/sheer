import { FileOutput, FilePlus, FileText, FileUp, RotateCcw, RotateCw, Scissors, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import { runAction } from '../../actions/dispatch';
import { shortcutFor } from '../../actions/registry';
import { Button, IconButton, Menu, Slider, type MenuEntry } from '../../components';
import { useT } from '../../i18n';
import { detectPlatform } from '../../lib/platform';
import { useSettings } from '../../stores/settings';
import { useUi } from '../../stores/ui';
import { deletePages, insertBlank, insertFromFile, rotatePages } from './commands';
import { GRID_THUMB } from './grid';
import { useSlots } from './source';
import { selectionOf, useOrganize } from './store';

export interface OrganizeBarProps {
  docId: number;
}

/**
 * The organize bar (DESIGN 3.28): a G1 strip of 40 px at the top of the grid. Rotate and Delete act on the selection (else the
 * focused page), Insert opens a menu (a blank page, or the pages of another file) and goes after the focused page, Extract… and Split…
 * are the jobs' actions. The thumbnail size slider is at the trailing end, then Done. A command that cannot act now (nothing to act
 * on, the last page) stays focusable and does nothing (`aria-disabled`).
 */
export function OrganizeBar({ docId }: OrganizeBarProps) {
  const t = useT();
  const platform = useSettings((state) => state.platform) ?? detectPlatform();
  const slots = useSlots(docId);
  const thumb = useOrganize((state) => state.thumb);
  const selection = useOrganize((state) => selectionOf(state, docId));
  const targets = selection.selected.length > 0 ? selection.selected.length : selection.focus === null ? 0 : 1;
  const none = targets === 0;
  const cannotDelete = none || targets >= slots.length;
  const shortcut = (id: 'rotate-view-left' | 'rotate-view-right') => {
    const found = shortcutFor(id, platform, t);
    return { shortcut: found?.label, keyShortcuts: found?.aria };
  };

  const insertEntries = useMemo<MenuEntry[]>(
    () => [
      { id: 'blank', label: t('organize.blank'), icon: FileText, onSelect: () => void insertBlank(docId) },
      { id: 'from-file', label: t('organize.fromFile'), icon: FileUp, onSelect: () => void insertFromFile(docId) },
    ],
    [t, docId],
  );

  return (
    <div
      role="toolbar"
      aria-label={t('toolbar.tool.pages')}
      className="glass-1 mx-1 mt-1 flex h-control-lg shrink-0 items-center gap-0-5 rounded-panel px-0-5"
    >
      <IconButton
        label={t('rotate.left')}
        icon={RotateCcw}
        {...shortcut('rotate-view-left')}
        disabled={none}
        focusableWhenDisabled
        onClick={() => void rotatePages(docId, -1)}
      />
      <IconButton
        label={t('rotate.right')}
        icon={RotateCw}
        {...shortcut('rotate-view-right')}
        disabled={none}
        focusableWhenDisabled
        onClick={() => void rotatePages(docId, 1)}
      />
      <IconButton
        label={t('organize.delete')}
        icon={Trash2}
        disabled={cannotDelete}
        focusableWhenDisabled
        onClick={() => void deletePages(docId)}
      />
      <div role="separator" aria-orientation="vertical" className="mx-1 h-2 w-hairline shrink-0 bg-divider" />
      <Menu
        label={t('organize.insert')}
        entries={insertEntries}
        trigger={(trigger) => <IconButton {...trigger} label={t('organize.insert')} icon={FilePlus} />}
      />
      <Button
        variant="ghost"
        size="sm"
        icon={FileOutput}
        disabled={none}
        focusableWhenDisabled
        onClick={() => runAction('extract-pages')}
      >
        {t('action.extractPages')}
      </Button>
      <Button variant="ghost" size="sm" icon={Scissors} onClick={() => runAction('split-document')}>
        {t('action.split')}
      </Button>
      <div className="flex-auto" />
      <Slider
        label={t('organize.size')}
        hideLabel
        value={thumb}
        min={GRID_THUMB.min}
        max={GRID_THUMB.max}
        step={GRID_THUMB.step}
        unit="px"
        onValueChange={(value) => useOrganize.getState().setThumb(value)}
      />
      <Button variant="primary" size="sm" onClick={() => useUi.getState().releaseTool()}>
        {t('organize.done')}
      </Button>
    </div>
  );
}
