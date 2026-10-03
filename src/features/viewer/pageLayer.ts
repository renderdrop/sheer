/**
 * What every per-page canvas layer gets from `PageView` (layer 3, DESIGN 3.23): the page's geometry as the form and annotation
 * layers have it. M5's insert, crop and redaction layers (src/features/{insert,crop,redact}) take exactly this.
 */
export interface PageLayerProps {
  docId: number;
  /** The page's id (ADR-036). */
  pageIndex: number;
  /** The page's box as it is shown, in px (the view rotation applied). */
  boxWidth: number;
  boxHeight: number;
  /** The page as it is drawn, in points (the file's `/Rotate` applied, the view rotation not). */
  widthPt: number;
  heightPt: number;
  rotation: number;
  /** The page's own rotation is known; before that a layer would be misplaced by it. */
  ready: boolean;
}
