import fsp from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import { PDF_OPTIONS } from '../ingest/extractors/pdf.ts';
import { downscale, encodePng } from './image.ts';
import { toPixels, type PdfJsImage } from './pdf-image.ts';

/**
 * Worker-Thread: Bilder einer PDF-Seite holen (pdf.js dekodiert JPEG/Flate/CCITT/JBIG2 in reinem JS) und als PNG kodieren.
 * Bewusst KEIN Rastern der Seite (bräuchte ein natives Canvas-Modul): gescannte Seiten bestehen praktisch immer aus
 * einem Seitenbild – das wird an das Vision-Modell gegeben. Die Operatorliste wird selbst ausgewertet, damit auch
 * Schwarz-Weiß-Scans (1 Bit/Pixel), Bildmasken (/ImageMask, typisch für Fax-/CCITT-Scans) und Inline-Bilder erfasst werden.
 * pdf.js verwirft Bilder über MAX_PDF_IMAGE_PIXELS, bevor es sie dekodiert (Dekompressionsbomben).
 */
export interface PageImageRequest {
  id: number;
  page: number;
  /** höchstens so viele Bilder (größte zuerst) */
  max: number;
  /** kleinere Bilder (Logos, Icons) ignorieren */
  minSide: number;
  /** längere Seite wird auf diesen Wert verkleinert */
  maxSide: number;
}

export interface PageImage {
  png: Uint8Array;
  width: number;
  height: number;
}

const { path } = workerData as { path: string };
const pdfPromise = fsp.readFile(path).then((buf) => getDocumentProxy(new Uint8Array(buf), PDF_OPTIONS));

type ObjStore = { get(id: string, cb: (v: unknown) => void): void };
type PdfPage = { getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: ObjStore; commonObjs: ObjStore; cleanup(): void };

function resolveObj(page: PdfPage, id: string): Promise<PdfJsImage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    (id.startsWith('g_') ? page.commonObjs : page.objs).get(id, (v) => {
      clearTimeout(timer);
      resolve((v as PdfJsImage) ?? null);
    });
  });
}

async function pageImages(req: PageImageRequest): Promise<PageImage[]> {
  const pdf = await pdfPromise;
  const { OPS } = await getResolvedPDFJS();
  const page = (await pdf.getPage(req.page)) as unknown as PdfPage;
  const list = await page.getOperatorList();
  const found: { img: PdfJsImage; mask: boolean }[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const arg = list.argsArray[i]?.[0] as unknown;
    if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const img = typeof arg === 'string' ? await resolveObj(page, arg) : null;
      if (img) found.push({ img, mask: false });
    } else if (fn === OPS.paintInlineImageXObject) {
      if (arg && typeof arg === 'object') found.push({ img: arg as PdfJsImage, mask: false });
    } else if (fn === OPS.paintImageMaskXObject || fn === OPS.paintImageMaskXObjectRepeat) {
      const a = arg as { data?: unknown; width: number; height: number } | undefined;
      if (!a) continue;
      const img = typeof a.data === 'string' ? await resolveObj(page, a.data) : (a as PdfJsImage);
      if (img) found.push({ img: { ...img, width: img.width ?? a.width, height: img.height ?? a.height }, mask: true });
    }
  }
  const out: PageImage[] = [];
  const picked = found
    .filter((f) => Math.min(f.img.width, f.img.height) >= req.minSide)
    .sort((x, y) => y.img.width * y.img.height - x.img.width * x.img.height);
  for (const f of picked) {
    if (out.length >= req.max) break;
    const px = toPixels(f.img, f.mask);
    if (!px) continue;
    const small = downscale(px.data, f.img.width, f.img.height, px.channels, req.maxSide);
    out.push({ png: encodePng(small.data, small.width, small.height, px.channels), width: small.width, height: small.height });
  }
  page.cleanup();
  return out;
}

parentPort?.on('message', (req: PageImageRequest) => {
  pageImages(req).then(
    (images) => parentPort!.postMessage({ id: req.id, ok: true, images }),
    (err: unknown) => parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), name: (err as { name?: string })?.name }),
  );
});
