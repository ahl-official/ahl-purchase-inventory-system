"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, RefreshCw, Upload, X, Check, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface CapturedPhoto {
  /** data: URL, for preview only. Never sent to the backend. */
  dataUrl: string;
  /** Raw base64 with no data: prefix. This is what Apps Script decodes. */
  base64: string;
  mimeType: string;
  fileName: string;
  /** Decoded byte size after compression. */
  sizeBytes: number;
}

interface PhotoCaptureProps {
  onCapture: (photo: CapturedPhoto | null) => void;
  /** Longest edge in px after downscaling. 1600 keeps printed bill text legible. */
  maxEdge?: number;
  /** Compression target. Apps Script chokes well before this, so stay conservative. */
  targetBytes?: number;
  /** Pass "" when the surrounding panel already carries the heading. */
  label?: string;
  disabled?: boolean;
}

type Mode = "idle" | "live" | "captured";

/** Rough decoded size of a base64 string, without allocating a Buffer. */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Draws a source image onto a canvas scaled to fit maxEdge, then steps JPEG
 * quality down until the encoded result fits under targetBytes. Returns the
 * smallest acceptable result, or the lowest-quality attempt if none fit.
 */
function compressToDataUrl(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
  targetBytes: number
): { dataUrl: string; base64: string; sizeBytes: number } {
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable.");

  // Bills are photographed under poor light; a white base avoids
  // transparent-corner artifacts when the source has an alpha channel.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);

  let dataUrl = "";
  let base64 = "";
  let sizeBytes = 0;

  for (const quality of [0.82, 0.7, 0.6, 0.5, 0.42, 0.35]) {
    dataUrl = canvas.toDataURL("image/jpeg", quality);
    base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    sizeBytes = base64Bytes(base64);
    if (sizeBytes <= targetBytes) break;
  }

  return { dataUrl, base64, sizeBytes };
}

export function PhotoCapture({
  onCapture,
  maxEdge = 1600,
  targetBytes = 600 * 1024,
  label = "Photo of the physical bill",
  disabled = false,
}: PhotoCaptureProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Release the camera if the component unmounts mid-capture (e.g. tab switch).
  useEffect(() => stopStream, [stopStream]);

  const startCamera = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("NO_CAMERA_API");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        // "environment" = rear camera on a phone; desktops fall back to the only one.
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setMode("live");
      // The video element only exists after the mode flip, so attach next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => undefined);
        }
      });
    } catch (err) {
      stopStream();
      setMode("idle");
      const name = err instanceof Error ? err.name : "";
      setError(
        name === "NotAllowedError"
          ? "Camera permission denied. Allow it in your browser settings, or use Upload."
          : name === "NotFoundError"
            ? "No camera on this device. Use Upload instead."
            : "Could not start the camera. Use Upload instead."
      );
    } finally {
      setStarting(false);
    }
  }, [stopStream]);

  const commit = useCallback(
    (next: CapturedPhoto) => {
      setPhoto(next);
      setMode("captured");
      setError(null);
      onCapture(next);
    },
    [onCapture]
  );

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) {
      setError("The camera is still warming up. Try again in a moment.");
      return;
    }
    try {
      const { dataUrl, base64, sizeBytes } = compressToDataUrl(
        video,
        video.videoWidth,
        video.videoHeight,
        maxEdge,
        targetBytes
      );
      stopStream();
      commit({
        dataUrl,
        base64,
        sizeBytes,
        mimeType: "image/jpeg",
        fileName: `bill-${Date.now()}.jpg`,
      });
    } catch {
      setError("Could not capture the frame. Try again.");
    }
  }, [commit, maxEdge, stopStream, targetBytes]);

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("That file is not an image.");
        return;
      }
      setError(null);

      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const { dataUrl, base64, sizeBytes } = compressToDataUrl(
            img,
            img.naturalWidth,
            img.naturalHeight,
            maxEdge,
            targetBytes
          );
          commit({
            dataUrl,
            base64,
            sizeBytes,
            mimeType: "image/jpeg",
            fileName: `bill-${Date.now()}.jpg`,
          });
        } catch {
          setError("Could not process that image.");
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setError("Could not read that image file.");
      };
      img.src = objectUrl;
    },
    [commit, maxEdge, targetBytes]
  );

  const reset = useCallback(() => {
    stopStream();
    setPhoto(null);
    setError(null);
    setMode("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
    onCapture(null);
  }, [onCapture, stopStream]);

  return (
    <div className="space-y-3">
      {label && (
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {photo && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" />
              {formatSize(photo.sizeBytes)}
            </span>
          )}
        </div>
      )}

      {/* Hidden fallback input. capture="environment" opens the camera app directly
          on mobile; on desktop it is an ordinary file picker. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />

      {mode === "idle" && (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-5 py-8 text-center">
          <Camera className="mx-auto mb-3 size-8 text-muted-foreground/60" />
          <p className="mx-auto mb-5 max-w-sm text-sm text-muted-foreground">
            Photograph the delivery bill. It is compressed on this device before
            upload, so a weak connection still works.
          </p>
          <div className="flex flex-col justify-center gap-2 sm:flex-row">
            <Button
              type="button"
              size="lg"
              onClick={startCamera}
              disabled={disabled || starting}
              className="h-11 px-5"
            >
              <Camera className="size-4" />
              {starting ? "Starting camera…" : "Open camera"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="h-11 px-5"
            >
              <Upload className="size-4" />
              Upload a file
            </Button>
          </div>
        </div>
      )}

      {mode === "live" && (
        <div className="space-y-3">
          <div className="relative overflow-hidden rounded-lg border border-border bg-foreground">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="max-h-[60vh] w-full object-contain"
            />
            <button
              type="button"
              onClick={reset}
              aria-label="Close camera"
              className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
            >
              <X className="size-4" />
            </button>
          </div>
          <Button
            type="button"
            size="lg"
            onClick={takePhoto}
            className="h-12 w-full text-[0.9375rem] font-semibold"
          >
            <Camera className="size-4" />
            Capture bill
          </Button>
        </div>
      )}

      {mode === "captured" && photo && (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
            {/* Local canvas output, not a remote asset: next/image adds nothing here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photo.dataUrl}
              alt="Captured delivery bill"
              className="max-h-[50vh] w-full object-contain"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground tabular">
              {formatSize(photo.sizeBytes)} · compressed JPEG
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={startCamera}
                disabled={disabled}
                className="h-9"
              >
                <RefreshCw className="size-3.5" />
                Retake
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={reset}
                disabled={disabled}
                className="h-9 text-danger hover:bg-danger-subtle hover:text-danger"
              >
                Remove
              </Button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-subtle px-3.5 py-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

export default PhotoCapture;
