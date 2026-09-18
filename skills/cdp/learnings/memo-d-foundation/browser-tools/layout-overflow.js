// learnings/memo-d-foundation/browser-tools/layout-overflow.js
// Report viewport width, document horizontal overflow, and any images under
// .memo-content or .prose that render wider than their parent element.

async function layoutOverflow() {
  const vw = innerWidth;
  const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;

  const images = document.querySelectorAll('.memo-content img, .prose img');
  const wideImages = [];
  for (const img of images) {
    const parent = img.parentElement;
    if (!parent) continue;
    const width = img.getBoundingClientRect().width;
    const parentWidth = parent.getBoundingClientRect().width;
    if (width > parentWidth) {
      const src = img.currentSrc || img.src || '';
      wideImages.push({
        src: src.split('/').pop() || src,
        width,
        parentWidth,
        naturalWidth: img.naturalWidth,
        maxWidth: getComputedStyle(img).maxWidth,
      });
    }
  }

  return { vw, docOverflow, wideImages };
}
