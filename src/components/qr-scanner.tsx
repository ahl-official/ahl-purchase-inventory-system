"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface QrScannerProps {
  onDecode: (text: string) => void;
  onClose: () => void;
}

/** Long edge of the offscreen decode canvas. Small enough to keep jsQR fast
 * and light on battery, large enough to read a printed label at arm's length. */
const DECODE_EDGE = 480;

export function QrScanner({ onDecode, onClose }: QrScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Keep a stable ref to the latest onDecode so the camera-lifecycle effect
  // below can run exactly once (mount/unmount) instead of restarting the
  // camera whenever the parent re-renders with a new function identity.
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame: number | null = null;
    let stopped = false;

    // A hoisted function declaration (not a hook-tracked callback) so it can
    // call itself for the next frame without a stale-closure lint concern.
    function tick() {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.videoWidth) {
        const scale = Math.min(1, DECODE_EDGE / Math.max(video.videoWidth, video.videoHeight));
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, width, height);
          const imageData = ctx.getImageData(0, 0, width, height);
          const result = jsQR(imageData.data, width, height);
          if (result?.data) {
            stopped = true;
            stream?.getTracks().forEach((track) => track.stop());
            onDecodeRef.current(result.data);
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    }

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("NO_CAMERA_API");
        }
        const opened = await navigator.mediaDevices.getUserMedia({
          // "environment" = rear camera on a phone; desktops fall back to the only one.
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (stopped) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        if (videoRef.current) {
          videoRef.current.srcObject = opened;
          await videoRef.current.play().catch(() => undefined);
        }
        setStarting(false);
        frame = requestAnimationFrame(tick);
      } catch (err) {
        if (stopped) return;
        const name = err instanceof Error ? err.name : "";
        setError(
          name === "NotAllowedError"
            ? "Camera permission denied. Allow it in your browser settings, or select the product from the list below."
            : name === "NotFoundError"
              ? "No camera on this device. Select the product from the list below."
              : "Could not start the camera. Select the product from the list below."
        );
        setStarting(false);
      }
    })();

    // Release the camera on unmount (e.g. Cancel, or the parent closing this
    // view) or if the effect re-runs.
    return () => {
      stopped = true;
      if (frame !== null) cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Scan product code</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cancel scan"
          className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <X className="size-4" />
        </button>
      </div>

      {!error && (
        <div className="relative overflow-hidden rounded-lg border border-border bg-foreground">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="max-h-[50vh] w-full object-contain"
          />
          {starting && (
            <div className="absolute inset-0 grid place-items-center bg-black/40 text-sm text-white">
              Starting camera…
            </div>
          )}
          <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-white/70" />
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" />

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-subtle px-3.5 py-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <Button type="button" variant="outline" onClick={onClose} className="w-full">
        Cancel
      </Button>
    </div>
  );
}

export default QrScanner;
