import { requireOptionalNativeModule } from 'expo';

export type VisionLine = { text: string; left: number; top: number; width: number; height: number };
export type VisionResult = { text: string; lines: VisionLine[] };
export type DetectResult = { uri: string; detected: boolean };
/** A written JPEG: file:// URI and pixel size. */
export type ImageResult = { uri: string; width: number; height: number };

/** Something NSDataDetector found in text. `range` is [start, length] in UTF-16 units (JS string indices). */
export type DetectedDataType = 'phone' | 'email' | 'url' | 'address' | 'date';
export type DetectedData = {
  type: DetectedDataType;
  /** The matched text as it appears. */
  text: string;
  range: [number, number];
  /** phone: the number; email: the address; url: the absolute URL; address/date: the matched text. */
  value: string;
  /** address only: the parts NSDataDetector recognised. */
  address?: { street?: string; city?: string; state?: string; postalCode?: string; country?: string; name?: string; organization?: string };
  /** date only: ms since the epoch, and the duration in seconds (0 for a single moment). */
  date?: number;
  duration?: number;
  /** date only: the text names a time of day (else it's a whole day). */
  hasTime?: boolean;
  timeZone?: string;
};
/** A QR code or barcode in an image; the box is normalised 0..1 in the upright image. */
export type DetectedBarcode = {
  symbology: string;
  payload: string;
  left: number;
  top: number;
  width: number;
  height: number;
};
export type SpeechState = 'speaking' | 'paused' | 'finished' | 'stopped';
export type SpeechStateEvent = { id: number; state: SpeechState };
export type SpeechProgressEvent = { id: number; start: number; length: number };
/** Fields of a contact (business card). Phone labels: work (default) | mobile | fax | main. */
export type ContactFields = {
  givenName?: string;
  middleName?: string;
  familyName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  organizationName?: string;
  departmentName?: string;
  jobTitle?: string;
  phones?: { number: string; label?: 'work' | 'mobile' | 'fax' | 'main' }[];
  emails?: string[];
  urls?: string[];
  addresses?: { street?: string; city?: string; state?: string; postalCode?: string; country?: string }[];
  note?: string;
  /** file:// image used as the contact photo. */
  imageUri?: string;
};
// ── Fill & sign (round 13). Rects are [x, y, width, height] in a page's PDF
// space (points, origin bottom-left, before the page's rotation).
export type NativeFillPage = { crop: number[]; media: number[]; rotation: number };
export type NativeFillField = {
  /** "page:annotationIndex", as pdfFill expects it back. */
  id: string;
  page: number;
  name: string;
  kind: 'text' | 'choice' | 'checkbox' | 'radio' | 'signature';
  rect: number[];
  readOnly: boolean;
  /** 0: automatic. */
  fontSize: number;
  /** The form's description of the field (/TU), '' when none (newer builds). */
  label?: string;
  value?: string;
  multiline?: boolean;
  maxLength?: number;
  comb?: boolean;
  align?: 'left' | 'center' | 'right';
  options?: string[];
  list?: boolean;
  on?: boolean;
  onValue?: string;
};
export type NativeFillInfo = {
  pageCount: number;
  encrypted: boolean;
  /** The PDF's permissions allow adding text and signatures. */
  canAnnotate: boolean;
  /** …and filling its form. */
  canFillForms: boolean;
  pages: NativeFillPage[];
  fields: NativeFillField[];
};
export type NativeFieldValue = { id: string; name: string; kind: string; value?: string; on?: boolean };
export type NativeMark = {
  page: number;
  rect: number[];
  kind: 'text' | 'check' | 'cross' | 'image';
  text?: string;
  fontSize?: number;
  color?: string;
  /** base64 PNG (a data: URI is fine). */
  image?: string;
};
/** How a system form presented by the module ended. */
export type PresentOutcome = 'saved' | 'cancelled' | 'denied' | 'unavailable';

type VisionOcrNative = {
  recognize(uri: string): Promise<VisionResult>;
  /** Present only in dev clients built after document detection was added. */
  detectDocument?: (uri: string, quality: number) => Promise<DetectResult>;
  /** Present only in dev clients built after PDF protection was added. */
  protectPdf?: (inputUri: string, outputUri: string, password: string) => Promise<string>;
  /** Present only in dev clients built after PDF page rendering was added. */
  renderPdfPages?: (inputUri: string, outputDirUri: string, maxEdge: number) => Promise<string[]>;
  /** Present only in dev clients built after PDF merging was added. */
  mergePdfs?: (inputUris: string[], outputUri: string) => Promise<string>;
  /** Embedded text per page; rejects with message "locked" when a password is needed. */
  pdfPageTexts?: (uri: string, password?: string | null) => Promise<string[]>;
  /** Unencrypted copy of a protected PDF; rejects with "wrong-password". */
  unlockPdf?: (inputUri: string, outputUri: string, password: string) => Promise<string>;
  /** One share sheet with several files; only lib/share.ts may call it (lock gate). */
  shareFiles?: (uris: string[], title?: string | null) => Promise<void>;
  /** Copy a system-provided (possibly security-scoped) file into the app. */
  copyIncomingFile?: (sourceUri: string, destUri: string) => Promise<string>;
  /**
   * Page outline in a photo: [x0,y0, x1,y1, x2,y2, x3,y3] = top-left, top-right,
   * bottom-right, bottom-left, normalised 0..1, top-left origin, in the photo's
   * UPRIGHT orientation (EXIF applied). Corners sit on the paper edge (no
   * inset). null when no confident outline (>= 15% of the photo) is found.
   * Rejects ERR_IMAGE_READ for an unreadable file.
   */
  detectQuad?: (uri: string) => Promise<number[] | null>;
  /**
   * Perspective-correct `quad` (same convention as detectQuad) of the upright
   * source into an upright JPEG (no EXIF rotation) with the long edge capped at
   * `maxEdge`. The corner order decides the output's orientation: a cyclic
   * shift of the list turns the page by 90 degrees clockwise per step. An
   * upright axis-aligned quad is a plain crop, so [0,0,1,0,1,1,0,1] returns the
   * whole image unchanged in geometry. Rejects ERR_BAD_QUAD (not 8 finite
   * numbers within -0.01..1.01, or not a convex, clockwise, non-degenerate
   * quad), ERR_BAD_ARGS, ERR_IMAGE_READ, ERR_IMAGE_WRITE, ERR_WARP.
   */
  warpQuad?: (srcUri: string, quad: number[], outUri: string, quality: number, maxEdge: number) => Promise<ImageResult>;
  /**
   * Writes a PDF whose pages are, in order, input pages `sources[i]` (each at
   * most once) turned by `rotations[i]` degrees (a multiple of 90, added to the
   * page's own rotation), or for a negative `sources[i]` = -(k + 1) a blank
   * page shaped like input page k. Pages are moved, not redrawn: text stays
   * selectable. The output is read back and checked before this resolves to
   * its page count. Rejects ERR_PDF_LOCKED (message "locked") when the PDF needs
   * a password that wasn't given, ERR_PDF_RESTRICTED (message "restricted")
   * when its permissions don't allow changing pages, ERR_PDF_EDIT otherwise.
   */
  pdfEditPages?: (
    inputUri: string,
    outputUri: string,
    sources: number[],
    rotations: number[],
    password?: string | null,
  ) => Promise<number>;
  /**
   * Page count and protection of a PDF. Rejects ERR_PDF_INFO when it can't be opened.
   * `restricted` (newer builds; treat undefined as false): the PDF opens
   * without a password but its permissions don't allow changing its pages, so
   * pdfEditPages / mergePdfs reject it with ERR_PDF_RESTRICTED ("restricted").
   */
  pdfInfo?: (uri: string, password?: string | null) => Promise<{ pageCount: number; locked: boolean; encrypted: boolean; restricted?: boolean }>;
  /** Moves `srcUri` over `destUri` in one atomic rename (dest is never missing or partial). */
  replaceFile?: (srcUri: string, destUri: string) => Promise<string>;
  /** Upright JPEG copy (EXIF orientation baked into the pixels), long edge capped at maxEdge (never upscaled). */
  normalizeImage?: (srcUri: string, outUri: string, maxEdge: number, quality: number) => Promise<ImageResult>;
  // ── Acting on recognised text (round 12). Call through lib/text-actions.ts, which
  // checks presence and keeps the system forms behind App Lock.
  /** Phone numbers, emails, links, addresses and dates in `text` (NSDataDetector). */
  detectData?: (text: string) => Promise<DetectedData[]>;
  /** QR codes and barcodes in an image file (Vision). Rejects ERR_BARCODES for an unreadable file. */
  detectBarcodes?: (uri: string) => Promise<DetectedBarcode[]>;
  /** Dominant language of `text` as a BCP-47 code ("en", "fr"), or null (NLLanguageRecognizer). */
  detectLanguage?: (text: string) => Promise<string | null>;
  /** People's, organisations' and places' names in `text` (NLTagger). */
  nameEntities?: (text: string) => Promise<{ people: string[]; organizations: string[]; places: string[] }>;
  /** Reads `text` aloud (stopping anything already being read). `rate` 0.1..1 of the maximum. */
  speak?: (text: string, language?: string | null, rate?: number | null) => Promise<{ id: number; language: string }>;
  pauseSpeaking?: () => Promise<void>;
  resumeSpeaking?: () => Promise<void>;
  stopSpeaking?: () => Promise<void>;
  /** Only lib/text-actions.ts may call it (App Lock). */
  presentEventEditor?: (
    title: string,
    startMs: number,
    endMs: number,
    allDay: boolean,
    notes?: string | null,
    location?: string | null,
  ) => Promise<PresentOutcome>;
  /** Only lib/text-actions.ts may call it (App Lock). */
  presentNewContact?: (fields: ContactFields) => Promise<PresentOutcome>;
  /** Writes a vCard (.vcf) of the contact; resolves its file:// URI. */
  writeVCard?: (fields: ContactFields, outputUri: string) => Promise<string>;
  // ── Fill & sign an imported PDF in place (round 13, PdfFiller.swift). Call
  // through lib/pdf-fill.ts, which checks presence.
  /** Pages, form fields and permissions. Rejects ERR_PDF_LOCKED ("locked") when a password is needed. */
  pdfFillInfo?: (uri: string) => Promise<NativeFillInfo>;
  /** One page as an upright JPEG (crop box, rotation applied), long edge maxEdge px. */
  pdfRenderPage?: (uri: string, index: number, outUri: string, maxEdge: number, hideFields: boolean) => Promise<ImageResult>;
  /**
   * Fills form fields and adds marks (PDF annotations with appearance
   * streams), writes `outputUri` and verifies it before resolving to its page
   * count. Rejects ERR_PDF_LOCKED, ERR_PDF_RESTRICTED ("restricted"),
   * ERR_PDF_CHANGED ("changed": the form isn't what pdfFillInfo reported),
   * ERR_PDF_FILL otherwise.
   */
  pdfFill?: (inputUri: string, outputUri: string, fields: NativeFieldValue[], marks: NativeMark[]) => Promise<number>;
  addListener?:<E extends 'onSpeechProgress' | 'onSpeechState'>(
    event: E,
    listener: (e: E extends 'onSpeechProgress' ? SpeechProgressEvent : SpeechStateEvent) => void,
  ) => { remove: () => void };
};

/** null on Android, on web, and in a dev client built before this module existed. */
export const VisionOcr = requireOptionalNativeModule<VisionOcrNative>('VisionOcr');

export {
  DocumentCameraView,
  isDocumentCameraAvailable,
  type DocumentCameraRef,
  type DocumentCameraViewProps,
  type CameraDetectionEvent,
  type CameraCaptureEvent,
  type CameraErrorEvent,
  type CameraPauseReason,
  type CameraStateEvent,
} from './DocumentCameraView';
