import fsp from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { extractImages, getDocumentProxy } from 'unpdf';
import { downscale, encodePng } from './image.ts';

/**
 * Worker-Thread: Bilder einer PDF-Seite holen (pdf.js dekodiert JPEG/Flate/CCITT/JBIG2 in reinem JS) und als PNG kodieren.
 * Bewusst KEIN Rastern der Seite (bräuchte ein natives Canvas-Modul): gescannte Seiten bestehen praktisch immer aus
 * genau einem Seitenbild – das wird an das Vision-Modell gegeben. Läuft im Worker, damit Dekodierung/Kompression den
 * Server-Event-Loop nicht blockiert.
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
const pdfPromise = fsp.readFile(path).then((buf) => getDocumentProxy(new Uint8Array(buf), { disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 }));

parentPort?.on('message', (req: PageImageRequest) => {
  (async () => {
    const pdf = await pdfPromise;
    const imgs = (await extractImages(pdf, req.page))
      .filter((i) => Math.min(i.width, i.height) >= req.minSide)
      .sort((a, b) => b.width * b.height - a.width * a.height)
      .slice(0, req.max);
    const out: PageImage[] = [];
    for (const i of imgs) {
      const small = downscale(i.data, i.width, i.height, i.channels, req.maxSide);
      out.push({ png: encodePng(small.data, small.width, small.height, i.channels), width: small.width, height: small.height });
    }
    return out;
  })().then(
    (images) => parentPort!.postMessage({ id: req.id, ok: true, images }),
    (err: unknown) => parentPort!.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err), name: (err as { name?: string })?.name }),
  );
});
