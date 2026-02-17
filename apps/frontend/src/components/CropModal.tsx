import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X, Check, Crop as CropIcon, Play } from "lucide-react";

interface CropModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (crop: { x: number; y: number; width: number; height: number }) => void;
  videoUrl: string;
  initialCrop?: { x: number; y: number; width: number; height: number };
  onTestCrop: (crop: { x: number; y: number; width: number; height: number; time: number }) => Promise<string>;
}

export function CropModal({ isOpen, onClose, onSave, videoUrl, initialCrop, onTestCrop }: CropModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [crop, setCrop] = useState(initialCrop || { x: 0, y: 0, width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    if (isOpen) {
      // If initialCrop is provided, we need to scale it to the visual size
      // But we can't do that until the video loads. 
      // For now, let's just reset or handle it if we have videoRef.
      setPreviewImage(null);
    }
  }, [isOpen]);

  // ... (mouse handlers same as before)

  const handleTestCrop = async () => {
    if (!videoRef.current) return;
    setLoadingPreview(true);
    try {
      const scale = getScale();
      const actualCrop = {
        x: Math.round(crop.x * scale.x),
        y: Math.round(crop.y * scale.y),
        width: Math.round(crop.width * scale.x),
        height: Math.round(crop.height * scale.y),
        time: videoRef.current.currentTime || 0,
      };
      
      const imgUrl = await onTestCrop(actualCrop);
      setPreviewImage(imgUrl);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingPreview(false);
    }
  };
// ... rest of component

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="bg-background rounded-lg shadow-lg max-w-4xl w-full max-h-[90vh] flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold">Crop Video</h3>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        <div className="flex-1 overflow-auto p-4 flex flex-col items-center gap-4">
          <div 
            ref={containerRef}
            className="relative inline-block cursor-crosshair select-none"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <video 
              ref={videoRef}
              src={videoUrl}
              className="max-h-[60vh] max-w-full object-contain"
              onLoadedMetadata={() => {
                 // Force update to ensure scale is correct?
              }}
            />
            {crop.width > 0 && (
              <div 
                className="absolute border-2 border-primary bg-primary/20"
                style={{
                  left: crop.x,
                  top: crop.y,
                  width: crop.width,
                  height: crop.height,
                }}
              />
            )}
          </div>

          <div className="flex gap-2">
             <Button variant="secondary" onClick={handleTestCrop} disabled={loadingPreview || crop.width === 0}>
               {loadingPreview ? "Generating..." : "Test Crop (1 Frame)"}
             </Button>
             {previewImage && (
               <div className="mt-2 border p-1 bg-muted">
                 <img src={previewImage} alt="Preview" className="h-32 object-contain" />
               </div>
             )}
          </div>
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>
            <Check className="h-4 w-4 mr-2" />
            Apply Crop
          </Button>
        </div>
      </div>
    </div>
  );
}
