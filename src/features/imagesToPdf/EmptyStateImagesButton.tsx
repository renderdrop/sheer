import { Images } from 'lucide-react';

import { Button, Icon } from '../../components';
import { useT } from '../../i18n';
import { useUi } from '../../stores/ui';

/** The ghost "Create PDF from images…" button in the empty state's drop card, 16 below the Open row (DESIGN 3.43). */
export function EmptyStateImagesButton() {
  const t = useT();
  return (
    <div className="mt-4 flex justify-center">
      <Button variant="ghost" onClick={() => useUi.getState().setImagesToPdfOpen(true)}>
        <Icon icon={Images} size={16} />
        {t('img2pdf.menu')}
      </Button>
    </div>
  );
}
