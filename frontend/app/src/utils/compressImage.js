/**
 * Сжимает изображение через Canvas перед загрузкой на сервер.
 * Уменьшает до maxDim×maxDim, конвертирует в JPEG с заданным качеством.
 * Если файл уже маленький (< minSizeKb КБ) — возвращает как есть.
 */
export async function compressImage(file, { maxDim = 1280, quality = 0.82, minSizeKb = 300 } = {}) {
  if (file.size < minSizeKb * 1024) return file;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);

      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width >= height) { height = Math.round(height * maxDim / width); width = maxDim; }
        else                 { width  = Math.round(width  * maxDim / height); height = maxDim; }
      }

      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        blob => {
          if (!blob) { resolve(file); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
        },
        'image/jpeg',
        quality,
      );
    };

    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}
