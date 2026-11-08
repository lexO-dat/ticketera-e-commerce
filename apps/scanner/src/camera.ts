import jsQR from "jsqr";

/**
 * Lector de QR con la cámara trasera. Usa `BarcodeDetector` (nativo, rápido) cuando el navegador
 * lo tiene y, si no, decodifica los cuadros con jsQR. Devuelve una función para detenerlo.
 */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options: { formats: string[] }) => BarcodeDetectorLike;
  }
}

export async function startScanner(
  video: HTMLVideoElement,
  onCode: (value: string) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute("playsinline", "true");
  await video.play();

  const detector = window.BarcodeDetector
    ? new window.BarcodeDetector({ formats: ["qr_code"] })
    : null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped) return;
    if (!busy && video.readyState >= video.HAVE_ENOUGH_DATA) {
      busy = true;
      try {
        if (detector) {
          const [code] = await detector.detect(video);
          if (code?.rawValue) onCode(code.rawValue);
        } else if (context) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data) onCode(code.data);
        }
      } catch {
        // Cuadro ilegible: se intenta con el siguiente.
      } finally {
        busy = false;
      }
    }
    requestAnimationFrame(() => void tick());
  };
  void tick();

  return () => {
    stopped = true;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
}
