import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { X, Check, Crop as CropIcon, Loader2 } from "lucide-react";

/** Crop as % margin from each edge (0–100): left, top, right, bottom */
export type CropPercent = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

interface CropModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (crop: CropPercent) => void;
  videoUrl: string;
  initialCrop?: CropPercent;
  /** When set, fetch provider crop preset as initial (overrides initialCrop) */
  providerId?: string | null;
  onTestCrop: (crop: CropPercent & { time: number }) => Promise<string>;
}

/** Convert old rect format (left, top, right, bottom as corners) to margin format */
function fromRectCorners(left: number, top: number, right: number, bottom: number): CropPercent {
  return {
    left,
    top,
    right: Math.max(0, 100 - right),
    bottom: Math.max(0, 100 - bottom),
  };
}

const HANDLE_SIZE = 12;
const HANDLE_HIT = 16;

export function CropModal({ isOpen, onClose, onSave, videoUrl, initialCrop, providerId, onTestCrop }: CropModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const [crop, setCrop] = useState<CropPercent>(() => {
    const ic = initialCrop;
    if (!ic) return { left: 0, top: 0, right: 0, bottom: 0 };
    if (ic.left + (ic.right ?? 0) < 100 && ic.top + (ic.bottom ?? 0) < 100)
      return ic as CropPercent;
    if ("right" in ic && "bottom" in ic && ic.right > ic.left && ic.bottom > ic.top)
      return fromRectCorners(ic.left, ic.top, ic.right, ic.bottom);
    return { left: 0, top: 0, right: 0, bottom: 0 };
  });
  const [dragMode, setDragMode] = useState<"draw" | HandleId | null>(null);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [startCrop, setStartCrop] = useState<CropPercent | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const applyCrop = (c: CropPercent) => {
        setCrop(c);
        setPreviewImage(null);
        setVideoReady(false);
      };
      if (providerId) {
        fetch(`/api/providers/${providerId}/crop`, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data && typeof data.left === "number" && typeof data.top === "number" && typeof data.right === "number" && typeof data.bottom === "number") {
              applyCrop({ left: data.left, top: data.top, right: data.right, bottom: data.bottom });
            } else {
              const ic = initialCrop;
              const c = !ic ? { left: 0, top: 0, right: 0, bottom: 0 } : ic as CropPercent;
              applyCrop(c);
            }
          })
          .catch(() => {
            const ic = initialCrop;
            const c = !ic ? { left: 0, top: 0, right: 0, bottom: 0 } : ic as CropPercent;
            applyCrop(c);
          });
      } else {
        const ic = initialCrop;
        let c: CropPercent;
        if (!ic) c = { left: 0, top: 0, right: 0, bottom: 0 };
        else if (ic.left + (ic.right ?? 0) < 100 && ic.top + (ic.bottom ?? 0) < 100)
          c = ic as CropPercent;
        else if ("right" in ic && "bottom" in ic && ic.right > ic.left && ic.bottom > ic.top)
          c = fromRectCorners(ic.left, ic.top, ic.right, ic.bottom);
        else c = { left: 0, top: 0, right: 0, bottom: 0 };
        applyCrop(c);
      }
    }
  }, [isOpen, initialCrop, providerId]);

  const getImageDisplayRect = useCallback(() => {
    const container = containerRef.current;
    const video = videoRef.current;
    if (!container || !video || !videoUrl) return null;
    const rect = video.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      left: rect.left - containerRect.left,
      top: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height,
    };
  }, [videoUrl, videoReady]);

  const percentToPx = useCallback(
    (pct: CropPercent) => {
      const rect = getImageDisplayRect();
      if (!rect) return { left: 0, top: 0, width: 0, height: 0 };
      const w = Math.max(0, (100 - pct.left - pct.right) / 100) * rect.width;
      const h = Math.max(0, (100 - pct.top - pct.bottom) / 100) * rect.height;
      return {
        left: (pct.left / 100) * rect.width,
        top: (pct.top / 100) * rect.height,
        width: w,
        height: h,
      };
    },
    [getImageDisplayRect]
  );

  const pxToPercent = useCallback(
    (px: { left: number; top: number; width: number; height: number }): CropPercent => {
      const rect = getImageDisplayRect();
      if (!rect || rect.width <= 0 || rect.height <= 0)
        return { left: 0, top: 0, right: 0, bottom: 0 };
      const rightPx = rect.width - px.left - px.width;
      const bottomPx = rect.height - px.top - px.height;
      return {
        left: Math.max(0, Math.min(100, (px.left / rect.width) * 100)),
        top: Math.max(0, Math.min(100, (px.top / rect.height) * 100)),
        right: Math.max(0, Math.min(100, (rightPx / rect.width) * 100)),
        bottom: Math.max(0, Math.min(100, (bottomPx / rect.height) * 100)),
      };
    },
    [getImageDisplayRect]
  );

  const hitTestHandle = useCallback(
    (clientX: number, clientY: number): HandleId | null => {
      const rect = getImageDisplayRect();
      if (!rect) return null;
      const r = percentToPx(crop);
      const baseLeft = rect.left + r.left;
      const baseTop = rect.top + r.top;
      const w = r.width;
      const h = r.height;
      const half = HANDLE_HIT / 2;

      const handles: { id: HandleId; x: number; y: number }[] = [
        { id: "nw", x: baseLeft, y: baseTop },
        { id: "n", x: baseLeft + w / 2, y: baseTop },
        { id: "ne", x: baseLeft + w, y: baseTop },
        { id: "e", x: baseLeft + w, y: baseTop + h / 2 },
        { id: "se", x: baseLeft + w, y: baseTop + h },
        { id: "s", x: baseLeft + w / 2, y: baseTop + h },
        { id: "sw", x: baseLeft, y: baseTop + h },
        { id: "w", x: baseLeft, y: baseTop + h / 2 },
      ];

      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return null;
      const localX = clientX - containerRect.left;
      const localY = clientY - containerRect.top;

      for (const handle of handles) {
        if (
          Math.abs(localX - handle.x) <= half &&
          Math.abs(localY - handle.y) <= half
        )
          return handle.id;
      }
      return null;
    },
    [crop, percentToPx, getImageDisplayRect]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current || !videoUrl) return;
    const rect = getImageDisplayRect();
    if (!rect) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const localX = e.clientX - containerRect.left - rect.left;
    const localY = e.clientY - containerRect.top - rect.top;

    const handle = hitTestHandle(e.clientX, e.clientY);
    if (handle) {
      e.preventDefault();
      setDragMode(handle);
      setStartCrop({ ...crop });
      setStartPos({ x: e.clientX, y: e.clientY });
      return;
    }

    if (localX >= 0 && localY >= 0 && localX <= rect.width && localY <= rect.height) {
      setDragMode("draw");
      const l = (localX / rect.width) * 100;
      const t = (localY / rect.height) * 100;
      setStartPos({ x: l, y: t });
      setCrop({ left: l, top: t, right: 100 - l, bottom: 100 - t });
    }
  };

  const handleMouseUp = useCallback(() => {
    setDragMode(null);
    setStartCrop(null);
  }, []);

  useEffect(() => {
    if (!dragMode) return;
    const onMove = (e: MouseEvent) => {
      const rect = getImageDisplayRect();
      if (!rect || !containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const localX = Math.max(0, Math.min(100, ((e.clientX - containerRect.left - rect.left) / rect.width) * 100));
      const localY = Math.max(0, Math.min(100, ((e.clientY - containerRect.top - rect.top) / rect.height) * 100));

      if (dragMode === "draw") {
        const l = Math.max(0, Math.min(100, Math.min(startPos.x, localX)));
        const t = Math.max(0, Math.min(100, Math.min(startPos.y, localY)));
        const r = Math.max(0, Math.min(100, 100 - Math.max(startPos.x, localX)));
        const b = Math.max(0, Math.min(100, 100 - Math.max(startPos.y, localY)));
        if (l + r < 100 && t + b < 100)
          setCrop({ left: l, top: t, right: r, bottom: b });
        return;
      }

      if (startCrop) {
        setCrop(() => {
          let left = startCrop.left;
          let top = startCrop.top;
          let right = startCrop.right;
          let bottom = startCrop.bottom;

          switch (dragMode) {
            case "nw":
              left = localX;
              top = localY;
              break;
            case "n":
              top = localY;
              break;
            case "ne":
              right = 100 - localX;
              top = localY;
              break;
            case "e":
              right = 100 - localX;
              break;
            case "se":
              right = 100 - localX;
              bottom = 100 - localY;
              break;
            case "s":
              bottom = 100 - localY;
              break;
            case "sw":
              left = localX;
              bottom = 100 - localY;
              break;
            case "w":
              left = localX;
              break;
          }

          left = Math.max(0, Math.min(100, left));
          top = Math.max(0, Math.min(100, top));
          right = Math.max(0, Math.min(100, right));
          bottom = Math.max(0, Math.min(100, bottom));
          if (left + right >= 100) right = Math.max(0, 100 - left);
          if (top + bottom >= 100) bottom = Math.max(0, 100 - top);

          return { left, top, right, bottom };
        });
      }
    };
    const onUp = () => handleMouseUp();
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragMode, startCrop, startPos, getImageDisplayRect, pxToPercent, handleMouseUp]);

  const handleSave = () => {
    onSave(crop);
    onClose();
  };

  const handleTestCrop = async () => {
    const time = videoRef.current?.currentTime ?? 0;
    setLoadingPreview(true);
    setPreviewImage(null);
    try {
      const imgUrl = await onTestCrop({
        ...crop,
        time,
      });
      setPreviewImage(imgUrl);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingPreview(false);
    }
  };

  const r = percentToPx(crop);
  const imgRect = getImageDisplayRect();
  const hasValidCrop = crop.left + crop.right < 100 && crop.top + crop.bottom < 100;

  const Slider = ({
    label,
    value,
    min,
    max,
    onChange,
  }: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (v: number) => void;
  }) => (
    <div className="flex items-center gap-2">
      <label className="text-xs text-muted-foreground w-14 shrink-0">{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={0.1}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-2.5 rounded-full bg-muted cursor-pointer range-thumb-smooth"
      />
      <span className="text-xs w-12 tabular-nums">{value.toFixed(1)}%</span>
    </div>
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg max-w-5xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Crop Video</h3>
            {providerId && (
              <p className="text-xs text-muted-foreground mt-0.5">Using provider preset — saving updates the global crop for this provider</p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 flex flex-col lg:flex-row gap-4">
          <div className="flex flex-col items-center gap-3">
            {videoUrl ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Draw a rectangle or drag edges/corners to resize. Use Test Crop for the current frame.
                </p>
                <div
                  ref={containerRef}
                  className="relative inline-block cursor-crosshair select-none"
                  onMouseDown={handleMouseDown}
                  onMouseUp={handleMouseUp}
                >
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    className="max-h-[45vh] max-w-full object-contain block"
                    controls
                    muted
                    playsInline
                    onLoadedData={() => setVideoReady(true)}
                  />
                  {hasValidCrop && imgRect && (
                    <>
                      <div
                        className="absolute border-[3px] border-cyan-400 bg-cyan-500/15 pointer-events-none shadow-[0_0_16px_rgba(34,211,238,0.6)]"
                        style={{
                          left: imgRect.left + r.left,
                          top: imgRect.top + r.top,
                          width: r.width,
                          height: r.height,
                        }}
                      />
                      {(
                        [
                          "nw",
                          "n",
                          "ne",
                          "e",
                          "se",
                          "s",
                          "sw",
                          "w",
                        ] as HandleId[]
                      ).map((h) => {
                        let x: number, y: number;
                        switch (h) {
                          case "nw":
                            x = r.left;
                            y = r.top;
                            break;
                          case "n":
                            x = r.left + r.width / 2;
                            y = r.top;
                            break;
                          case "ne":
                            x = r.left + r.width;
                            y = r.top;
                            break;
                          case "e":
                            x = r.left + r.width;
                            y = r.top + r.height / 2;
                            break;
                          case "se":
                            x = r.left + r.width;
                            y = r.top + r.height;
                            break;
                          case "s":
                            x = r.left + r.width / 2;
                            y = r.top + r.height;
                            break;
                          case "sw":
                            x = r.left;
                            y = r.top + r.height;
                            break;
                          case "w":
                            x = r.left;
                            y = r.top + r.height / 2;
                            break;
                        }
                        const cursor =
                          h === "nw" || h === "se"
                            ? "nwse-resize"
                            : h === "ne" || h === "sw"
                              ? "nesw-resize"
                              : h === "n" || h === "s"
                                ? "ns-resize"
                                : "ew-resize";
                        return (
                          <div
                            key={h}
                            className="absolute rounded-full bg-cyan-400 border-2 border-white shadow-md pointer-events-auto cursor-pointer hover:bg-cyan-300 hover:scale-110 transition-transform"
                            style={{
                              left: imgRect.left + x - HANDLE_SIZE / 2,
                              top: imgRect.top + y - HANDLE_SIZE / 2,
                              width: HANDLE_SIZE,
                              height: HANDLE_SIZE,
                              cursor,
                            }}
                            onMouseDown={(ev) => {
                              ev.stopPropagation();
                              setDragMode(h);
                              setStartCrop({ ...crop });
                              setStartPos({ x: ev.clientX, y: ev.clientY });
                            }}
                          />
                        );
                      })}
                    </>
                  )}
                </div>

                <div className="w-full max-w-md space-y-2 mt-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Margin % from each edge (0–100)
                  </span>
                  <Slider
                    label="Top"
                    value={crop.top}
                    min={0}
                    max={Math.max(0, 100 - crop.bottom - 1)}
                    onChange={(v) => setCrop((p) => ({ ...p, top: Math.min(v, 100 - p.bottom - 1) }))}
                  />
                  <Slider
                    label="Left"
                    value={crop.left}
                    min={0}
                    max={Math.max(0, 100 - crop.right - 1)}
                    onChange={(v) => setCrop((p) => ({ ...p, left: Math.min(v, 100 - p.right - 1) }))}
                  />
                  <Slider
                    label="Right"
                    value={crop.right}
                    min={0}
                    max={Math.max(0, 100 - crop.left - 1)}
                    onChange={(v) => setCrop((p) => ({ ...p, right: Math.min(v, 100 - p.left - 1) }))}
                  />
                  <Slider
                    label="Bottom"
                    value={crop.bottom}
                    min={0}
                    max={Math.max(0, 100 - crop.top - 1)}
                    onChange={(v) => setCrop((p) => ({ ...p, bottom: Math.min(v, 100 - p.top - 1) }))}
                  />
                </div>

                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleTestCrop}
                  disabled={loadingPreview || !hasValidCrop}
                >
                  {loadingPreview ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                  ) : (
                    <CropIcon className="h-3.5 w-3.5 mr-2" />
                  )}
                  Test Crop (1 frame)
                </Button>
              </>
            ) : (
              <p className="text-muted-foreground py-8">No video URL</p>
            )}
          </div>

          {previewImage && (
            <div className="flex flex-col border rounded-lg p-3 bg-muted/30 min-w-[200px]">
              <span className="text-xs font-medium text-muted-foreground mb-2">Crop preview</span>
              <img src={previewImage} alt="Crop preview" className="max-h-[40vh] object-contain rounded" />
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!hasValidCrop}>
            <Check className="h-4 w-4 mr-2" />
            Apply Crop
          </Button>
        </div>
      </div>
    </div>
  );
}
