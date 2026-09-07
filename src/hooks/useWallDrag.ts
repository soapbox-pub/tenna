import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

/** How long a finger has to stay put before the tile under it is picked up. */
const LONG_PRESS_MS = 500;

/**
 * How far it may wander first.
 *
 * Before the press goes long this is the difference between holding a tile
 * and scrolling the wall; after, between holding one and dragging it. The
 * same number for both, because it is the same question — has the finger
 * moved, or is it just a finger.
 */
const SLOP_PX = 10;

/** How near the edge of the screen a drag has to get before the wall follows. */
const EDGE_PX = 88;

/** How fast it follows, at the very edge, per frame. */
const SCROLL_PX = 14;

interface WallDragOptions {
  /** The addresses of the tiles on the wall, in the order they are drawn. */
  uris: string[];
  /** A tile was held still: open its menu, the way a launcher does. */
  onLongPress: (uri: string) => void;
  /** The held tile is now moving, so whatever the hold opened should go. */
  onDragStart: () => void;
  /** Dropped: put the first tile where the second one is. */
  onDrop: (from: string, to: string) => void;
}

/** Where a tile sits, in page coordinates, which survive the wall scrolling. */
interface Slot {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Gesture {
  index: number;
  pointerId: number;
  /** Where the finger went down, in page coordinates. */
  pageX: number;
  pageY: number;
  /** Where it is now, in viewport coordinates. */
  clientX: number;
  clientY: number;
  /** The press has gone long: the tile is held, and the wall stops scrolling. */
  armed: boolean;
  dragging: boolean;
  /** Where the tile would land if the finger lifted now. */
  to: number;
  slots: Slot[];
  timer: number;
  frame: number;
}

/** Which slot the tile at `index` is pushed into while `from` sits on `to`. */
function displaced(index: number, from: number, to: number): number {
  if (from < to && index > from && index <= to) return index - 1;
  if (from > to && index >= to && index < from) return index + 1;
  return index;
}

/**
 * Long press to pick a tile up, drag to put it somewhere else.
 *
 * The order of the gesture is the one Android uses, and it is the reason a
 * hold can mean two things without the user having to choose between them up
 * front. A press that stays still opens the tile's menu. Keep holding and
 * move, and the menu goes and the tile comes with the finger instead — so
 * "press and let go" and "press and drag" are the same gesture right up until
 * they aren't, and nothing has to be decided before the finger lands.
 *
 * Nothing is reordered until the finger lifts. What moves during the drag is
 * a transform on each tile: the one being carried follows the finger, the
 * ones it displaces slide into the slots they would take, and the list itself
 * is left alone so there is nothing to undo if the drag is abandoned.
 */
export function useWallDrag({ uris, onLongPress, onDragStart, onDrop }: WallDragOptions) {
  const gridRef = useRef<HTMLDivElement>(null);

  // Where every tile is, measured when the drag began, travels with the drag
  // rather than in a ref of its own: the transforms are worked out while
  // rendering, and what is rendered has to be state.
  const [drag, setDrag] = useState<
    { from: number; to: number; dx: number; dy: number; slots: Slot[] } | null
  >(null);

  /**
   * The frame the wall reorders in, during which nothing may animate.
   *
   * A dropped tile is in two places at once for an instant: the transform
   * still holds it under the finger, and the reorder has already moved the
   * box that transform is measured from. Left to transition, it leaps a slot
   * further on and then flies back — the tile arriving where it already was.
   * So the transforms and the reorder are taken in the same render with
   * transitions off, and the wall is simply drawn as it was left.
   */
  const [settling, setSettling] = useState(false);

  const gesture = useRef<Gesture | null>(null);

  // The click that follows a press the user did not mean as a tap. A menu
  // opened under the finger, or a tile was carried across the wall and set
  // down; either way, letting go should not also launch the thing.
  const swallow = useRef(false);

  // Read from listeners that outlive the render they were attached in.
  const latest = useRef({ uris, onLongPress, onDragStart, onDrop });

  useEffect(() => {
    latest.current = { uris, onLongPress, onDragStart, onDrop };
  });

  const handlers = useMemo(() => {
    /** Where every tile is right now, before anything has been moved. */
    function measure(): Slot[] {
      const tiles = gridRef.current?.querySelectorAll('[data-wall-slot]') ?? [];
      return [...tiles].map((tile) => {
        const rect = tile.getBoundingClientRect();
        return {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          w: rect.width,
          h: rect.height,
        };
      });
    }

    /** Follow the finger, and work out which slot the tile is over. */
    function update() {
      const g = gesture.current;
      const home = g?.slots[g.index];
      if (!g || !home) return;

      const dx = g.clientX + window.scrollX - g.pageX;
      const dy = g.clientY + window.scrollY - g.pageY;

      // Measured from the middle of the tile rather than from the finger: it
      // is the icon the user is aiming with, and it is not under their thumb.
      const cx = home.x + home.w / 2 + dx;
      const cy = home.y + home.h / 2 + dy;

      let to = g.index;
      let nearest = Infinity;

      g.slots.forEach((slot, i) => {
        const distance = Math.hypot(slot.x + slot.w / 2 - cx, slot.y + slot.h / 2 - cy);
        if (distance < nearest) {
          nearest = distance;
          to = i;
        }
      });

      g.to = to;
      setDrag({ from: g.index, to, dx, dy, slots: g.slots });
    }

    /** Drag a tile against the top or bottom of the screen and the wall moves. */
    function tick() {
      const g = gesture.current;
      if (!g || !g.dragging) return;

      const above = g.clientY;
      const below = window.innerHeight - g.clientY;

      const by =
        above < EDGE_PX
          ? -SCROLL_PX * (1 - above / EDGE_PX)
          : below < EDGE_PX
            ? SCROLL_PX * (1 - below / EDGE_PX)
            : 0;

      if (by !== 0) {
        window.scrollBy(0, by);
        update();
      }

      g.frame = requestAnimationFrame(tick);
    }

    function end(commit: boolean) {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;

      clearTimeout(g.timer);
      cancelAnimationFrame(g.frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);

      if (commit && g.dragging && g.to !== g.index) {
        const { uris: order, onDrop: drop } = latest.current;
        const from = order[g.index];
        const to = order[g.to];
        if (from && to) {
          drop(from, to);
          setSettling(true);
          // Two frames: one for the wall to be laid out in its new order with
          // nothing animating, and one to be sure that layout has been drawn
          // before movement is allowed again.
          requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)));
        }
      }

      setDrag(null);
    }

    function move(event: PointerEvent) {
      const g = gesture.current;
      if (!g || event.pointerId !== g.pointerId) return;

      g.clientX = event.clientX;
      g.clientY = event.clientY;

      const moved = Math.hypot(
        event.clientX + window.scrollX - g.pageX,
        event.clientY + window.scrollY - g.pageY,
      );

      if (!g.armed) {
        // Still deciding what this is. Movement this early means the wall is
        // being scrolled, and the tile under the finger is only scenery.
        if (moved > SLOP_PX) end(false);
        return;
      }

      if (!g.dragging) {
        if (moved <= SLOP_PX) return;
        // Measured now, while every tile is still where the layout put it.
        g.slots = measure();
        g.dragging = true;
        swallow.current = true;
        latest.current.onDragStart();
        g.frame = requestAnimationFrame(tick);
      }

      update();
    }

    function up(event: PointerEvent) {
      if (event.pointerId !== gesture.current?.pointerId) return;
      end(true);
    }

    function cancel(event: PointerEvent) {
      if (event.pointerId !== gesture.current?.pointerId) return;
      end(false);
    }

    /**
     * Whether the event happened on the tile, rather than in the menu the
     * tile opened.
     *
     * A tile's menu is a child of its slot in the React tree and a child of
     * the document body in the DOM, and React sends events up the tree it
     * knows about — so every press and every click inside the menu arrives
     * here as though it had happened on the tile underneath. It didn't, and
     * a menu whose first tap is eaten as the leftovers of the hold that
     * opened it is a menu that has to be tapped twice.
     */
    function onTile(event: { currentTarget: HTMLElement; target: EventTarget | null }): boolean {
      return event.currentTarget.contains(event.target as Node);
    }

    /**
     * The same three handlers on every slot.
     *
     * Which slot they are on is read off the element rather than closed over,
     * so this object is made once and never again — a handler per tile per
     * render is a lot of churn for a wall that mostly sits still.
     */
    const props = {
      onPointerDown(event: React.PointerEvent<HTMLElement>) {
        // A secondary button is a menu request, not a press.
        if (event.button !== 0) return;
        if (!onTile(event)) return;

        const index = Number(event.currentTarget.dataset.wallSlot);
        if (!Number.isInteger(index)) return;

        end(false);

        // A new press is a new question, whatever became of the last one. A
        // hold that opened a menu the user then dismissed by tapping the
        // wallpaper leaves nothing to swallow, and the tap after it is meant.
        swallow.current = false;

        const g: Gesture = {
          index,
          pointerId: event.pointerId,
          pageX: event.clientX + window.scrollX,
          pageY: event.clientY + window.scrollY,
          clientX: event.clientX,
          clientY: event.clientY,
          armed: false,
          dragging: false,
          to: index,
          slots: [],
          timer: 0,
          frame: 0,
        };

        g.timer = window.setTimeout(() => {
          g.armed = true;
          swallow.current = true;
          const uri = latest.current.uris[g.index];
          if (uri) latest.current.onLongPress(uri);
        }, LONG_PRESS_MS);

        gesture.current = g;

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
      },

      onClickCapture(event: React.MouseEvent<HTMLElement>) {
        if (!swallow.current || !onTile(event)) return;
        swallow.current = false;
        event.preventDefault();
        event.stopPropagation();
      },

      // The WebView's own long-press menu — copy image, select text — has
      // nothing to offer on an icon, and the tile's menu is already here.
      onContextMenu(event: React.MouseEvent<HTMLElement>) {
        event.preventDefault();
      },
    };

    /** Whether a gesture is far enough along to own the finger. */
    const held = () => gesture.current?.armed ?? false;

    return { props, held };
  }, []);

  /**
   * Once a tile is held, the wall stops scrolling under it.
   *
   * `touch-action` is decided when the finger lands and cannot be changed
   * halfway through, so the scroll is refused the only way it can be: by
   * preventing the touch moves themselves, from a listener registered as
   * non-passive. React's own are passive, so this one is added by hand.
   */
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const block = (event: TouchEvent) => {
      if (handlers.held()) event.preventDefault();
    };

    grid.addEventListener('touchmove', block, { passive: false });
    return () => grid.removeEventListener('touchmove', block);
  }, [handlers]);

  /**
   * Where the tile in a given slot should be drawn, mid-drag.
   *
   * The one being carried is under the finger and lifted off the wall; the
   * ones it has displaced sit in the slot they are being pushed into, and
   * slide there because the element they are on transitions its transform.
   * Nothing here changes the grid, so letting go of a drag halfway costs one
   * render and no bookkeeping.
   */
  function styleFor(index: number): CSSProperties | undefined {
    if (settling) return { transition: 'none' };
    if (!drag) return undefined;

    if (index === drag.from) {
      return {
        transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0) scale(1.12)`,
        transition: 'none',
        zIndex: 30,
        willChange: 'transform',
      };
    }

    const home = drag.slots[index];
    const slot = drag.slots[displaced(index, drag.from, drag.to)];
    if (!home || !slot) return undefined;

    return {
      transform: `translate3d(${slot.x - home.x}px, ${slot.y - home.y}px, 0)`,
      willChange: 'transform',
    };
  }

  return {
    gridRef,
    /** Spread on every slot, alongside its `data-wall-slot` index. */
    handlers: handlers.props,
    styleFor,
    /** Whether a tile is currently being carried, for whoever draws the wall. */
    dragging: drag !== null,
  };
}
