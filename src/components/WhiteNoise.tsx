import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface WhiteNoiseProps {
  className?: string;
  /** Frames per second for the static. */
  fps?: number;
  /** Width of one grain of static, in CSS pixels. */
  grain?: number;
}

/**
 * Animated analog TV static, drawn at one pixel per grain and scaled up with
 * pixelated rendering. Renders a single still frame when the user prefers
 * reduced motion.
 *
 * The canvas is sized from the element it fills rather than fixed, so the
 * grain stays the same size everywhere. A fixed buffer has to stretch to fit,
 * which is invisible on a tile of the same shape and obvious full screen:
 * 4:3 worth of noise pulled across a 16:9 window, every grain a wide
 * rectangle. Static doesn't have a shape.
 */
export function WhiteNoise({ className, fps = 24, grain = 4 }: WhiteNoiseProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let image: ImageData | undefined;
    let pixels: Uint32Array | undefined;

    /** Match the buffer to the box, one pixel per grain. */
    const measure = () => {
      const width = Math.max(1, Math.round(canvas.clientWidth / grain));
      const height = Math.max(1, Math.round(canvas.clientHeight / grain));
      if (image && canvas.width === width && canvas.height === height) return false;

      canvas.width = width;
      canvas.height = height;
      image = ctx.createImageData(width, height);
      pixels = new Uint32Array(image.data.buffer);
      return true;
    };

    const draw = () => {
      if (!image || !pixels) return;
      for (let i = 0; i < pixels.length; i++) {
        const v = (Math.random() * 256) | 0;
        pixels[i] = 0xff000000 | (v << 16) | (v << 8) | v;
      }
      ctx.putImageData(image, 0, 0);
    };

    measure();
    draw();

    // A resized canvas is a blank one, so redraw as soon as it's remeasured
    // rather than leaving a hole until the next frame.
    const observer = new ResizeObserver(() => {
      if (measure()) draw();
    });
    observer.observe(canvas);

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return () => observer.disconnect();
    }

    let raf = 0;
    let last = 0;
    const interval = 1000 / fps;

    const loop = (time: number) => {
      raf = requestAnimationFrame(loop);
      if (time - last < interval) return;
      last = time;
      draw();
    };

    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [fps, grain]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('h-full w-full [image-rendering:pixelated]', className)}
    />
  );
}
