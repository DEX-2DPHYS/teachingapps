// Figures and slides on a page, shared by the lecturer's whiteboard and the student viewer.
// A page can carry images under the ink: page.images = [{ id, src, x, y, w, h, bg }] in page units.
//   bg: true  = a slide filling the page (from "Import slides (PDF)"); drawn first, not movable
//   bg: false = a figure placed on the page ("Insert figure"), movable and resizable
// src is a web address (Supabase Storage) or, before it is uploaded, a data: URL. Images are only
// ever drawn onto the canvas (never inserted as HTML), so a received page cannot carry code.

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/';
export const SLIDE_WIDTH = 1920; // pixel width slides and figures are stored at (enough for a projector)

const okSrc = src => typeof src === 'string' && (/^https:\/\//.test(src) || /^data:image\/(webp|jpeg|png);/.test(src));
export const newImageId = () => 'i' + Math.random().toString(36).slice(2, 10);

// draw the page's images (slides first, then figures); images still loading are drawn once they
// arrive (onLoad is then called, e.g. to redraw the page)
const cache = new Map(); // src -> HTMLImageElement
export function drawImages(g, images, onLoad) {
  if (!images?.length) return;
  const list = images.filter(im => okSrc(im.src)).sort((a, b) => (b.bg ? 1 : 0) - (a.bg ? 1 : 0));
  for (const im of list) {
    let img = cache.get(im.src);
    if (!img) {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => onLoad?.();
      img.src = im.src;
      cache.set(im.src, img);
    }
    if (img.complete && img.naturalWidth) g.drawImage(img, im.x, im.y, im.w, im.h);
  }
}

// an image of natural size w x h, as large as fits inside the page (W x H), centred
export function fitInPage(w, h, W, H, margin = 0) {
  const k = Math.min((W - 2 * margin) / w, (H - 2 * margin) / h);
  return { x: (W - w * k) / 2, y: (H - h * k) / 2, w: w * k, h: h * k };
}

// canvas -> compressed blob: WebP when the browser can make it, otherwise JPEG
function canvasBlob(c, quality = 0.82) {
  return new Promise(res => c.toBlob(b => {
    if (b && b.type === 'image/webp') return res(b);
    c.toBlob(j => res(j), 'image/jpeg', quality);
  }, 'image/webp', quality));
}

// an image file (figure) -> { blob, w, h }, at most maxW pixels wide
export async function compressImage(file, maxW = SLIDE_WIDTH) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return { blob: await canvasBlob(c), w: c.width, h: c.height };
}

// a PDF (slides, exercise sheet) -> one image per page: [{ blob, w, h }]
export async function pdfToImages(file, { width = SLIDE_WIDTH, onProgress } = {}) {
  const pdfjs = await import(PDFJS + 'pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: width / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, canvas: c, viewport: vp }).promise;
    out.push({ blob: await canvasBlob(c), w: c.width, h: c.height });
    onProgress?.(i, pdf.numPages);
  }
  return out;
}

export const blobToDataUrl = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});
export const dataUrlToBlob = async url => (await fetch(url)).blob();

// what may be sent to students: uploaded images only, with their place (never data: URLs)
export const publicImages = images => (images || [])
  .filter(im => /^https:\/\//.test(im.src))
  .map(({ id, src, x, y, w, h, bg }) => ({ id, src, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h), bg: !!bg }));
