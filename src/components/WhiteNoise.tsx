import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

interface WhiteNoiseProps {
  className?: string;
  /** Frames per second for the static. */
  fps?: number;
}

/**
 * Animated analog TV static, drawn on a small canvas and scaled up with
 * pixelated rendering. Renders a single still frame when the user prefers
 * reduced motion.
 */
export function WhiteNoise({ className, fps = 24 }: WhiteNoiseProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const image = ctx.createImageData(canvas.width, canvas.height);
    const pixels = new Uint32Array(image.data.buffer);

    const draw = () => {
      for (let i = 0; i < pixels.length; i++) {
        const v = (Math.random() * 256) | 0;
        pixels[i] = 0xff000000 | (v << 16) | (v << 8) | v;
      }
      ctx.putImageData(image, 0, 0);
    };

    draw();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

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
    return () => cancelAnimationFrame(raf);
  }, [fps]);

  return (
    <canvas
      ref={canvasRef}
      width={128}
      height={96}
      aria-hidden="true"
      className={cn('h-full w-full [image-rendering:pixelated]', className)}
    />
  );
}
