/**
 * Events for targets that know their parents.
 *
 * IndexedDB's events travel from a request to its transaction to its
 * database, which a script-built `EventTarget` cannot do: `dispatchEvent`
 * only ever reaches the one target. The targets here are still plain
 * `EventTarget` subclasses — WebIDL puts `EventTarget.prototype` directly
 * under `IDBRequest.prototype`, and sites and tests look — so the realm's
 * `addEventListener`, `removeEventListener` and `dispatchEvent` are wrapped
 * once: for a target registered here they keep this module's listener lists
 * and run the DOM's dispatch over the target's path, and for anything else
 * they are the platform's own.
 *
 * The events are real `Event`s. Their `target`, `currentTarget`,
 * `eventPhase` and `composedPath` are shadowed per instance while this module
 * dispatches them; `cancelBubble` is the one piece of the native event's own
 * state that can be read back, and is how `stopPropagation` is noticed.
 *
 * An event the engine fires is dispatched asynchronously: between one
 * listener and the next, the microtasks the first left run, as they do when
 * the platform dispatches from a task of its own.
 */

export interface Dispatched {
  /** Whether a listener threw. */
  threw: boolean;
  /** Whether a listener called preventDefault. */
  canceled: boolean;
}

interface Listener {
  callback: EventListenerOrEventListenerObject;
  capture: boolean;
  once: boolean;
  passive: boolean;
  removed: boolean;
}

interface TargetState {
  listeners: Map<string, Listener[]>;
  parent: () => EventTarget | null;
}

interface EventState {
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  phase: number;
  path: EventTarget[];
  stopImmediate: boolean;
  passive: boolean;
}

const NativeEvent = Event;
const nativeStop = NativeEvent.prototype.stopPropagation;
const nativePreventDefault = NativeEvent.prototype.preventDefault;
const cancelBubble = Object.getOwnPropertyDescriptor(NativeEvent.prototype, 'cancelBubble')!.get!;

const targets = new WeakMap<EventTarget, TargetState>();
const events = new WeakMap<Event, EventState>();

/** Report an exception a listener threw, the way the platform reports one. */
export function reportException(error: unknown): void {
  const report = (globalThis as { reportError?: (e: unknown) => void }).reportError;
  if (typeof report === 'function') {
    report(error);
  } else {
    setTimeout(() => {
      throw error;
    });
  }
}

function prepare(event: Event): EventState {
  const existing = events.get(event);
  if (existing) return existing;
  const state: EventState = { target: null, currentTarget: null, phase: 0, path: [], stopImmediate: false, passive: false };
  events.set(event, state);
  Object.defineProperties(event, {
    target: { get: () => state.target, configurable: true },
    srcElement: { get: () => state.target, configurable: true },
    currentTarget: { get: () => state.currentTarget, configurable: true },
    eventPhase: { get: () => state.phase, configurable: true },
    composedPath: {
      value: () => (state.phase === 0 ? [] : state.path.slice()),
      configurable: true,
      writable: true,
    },
    stopImmediatePropagation: {
      value: () => {
        state.stopImmediate = true;
        nativeStop.call(event);
      },
      configurable: true,
      writable: true,
    },
    preventDefault: {
      value: () => {
        if (!state.passive) nativePreventDefault.call(event);
      },
      configurable: true,
      writable: true,
    },
  });
  return state;
}

function flatten(options: unknown): { capture: boolean; once: boolean; passive: boolean; signal?: AbortSignal } {
  if (typeof options === 'boolean') return { capture: options, once: false, passive: false };
  if (options === undefined || options === null || typeof options !== 'object') {
    return { capture: !!options, once: false, passive: false };
  }
  const o = options as AddEventListenerOptions;
  return { capture: !!o.capture, once: !!o.once, passive: !!o.passive, signal: o.signal };
}

function addListener(state: TargetState, target: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options: unknown): void {
  type = `${type}`;
  const { capture, once, passive, signal } = flatten(options);
  if (callback === null || callback === undefined) return;
  if (signal?.aborted) return;
  const list = state.listeners.get(type) ?? [];
  if (list.some((l) => l.callback === callback && l.capture === capture)) return;
  list.push({ callback, capture, once, passive, removed: false });
  state.listeners.set(type, list);
  signal?.addEventListener('abort', () => removeListener(state, type, callback, { capture }));
  void target;
}

function removeListener(state: TargetState, type: string, callback: EventListenerOrEventListenerObject | null, options: unknown): void {
  type = `${type}`;
  const { capture } = flatten(options);
  const list = state.listeners.get(type);
  if (!list) return;
  const at = list.findIndex((l) => l.callback === callback && l.capture === capture);
  if (at < 0) return;
  list[at].removed = true;
  list.splice(at, 1);
}

// Route the realm's EventTarget methods for targets registered here.
{
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  const dispatchNative = proto.dispatchEvent;
  const wrap = (name: string, length: number, fn: (this: EventTarget, ...args: never[]) => unknown) => {
    Object.defineProperty(fn, 'name', { value: name });
    Object.defineProperty(fn, 'length', { value: length });
    Object.defineProperty(proto, name, { value: fn, writable: true, enumerable: true, configurable: true });
  };
  wrap('addEventListener', 2, function (this: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: unknown) {
    const state = this === null || this === undefined ? undefined : targets.get(this);
    if (!state) return add.call(this, type, callback, options as AddEventListenerOptions);
    if (arguments.length < 2) throw new TypeError('addEventListener needs two arguments.');
    addListener(state, this, type, callback, options);
  });
  wrap('removeEventListener', 2, function (this: EventTarget, type: string, callback: EventListenerOrEventListenerObject | null, options?: unknown) {
    const state = this === null || this === undefined ? undefined : targets.get(this);
    if (!state) return remove.call(this, type, callback, options as EventListenerOptions);
    if (arguments.length < 2) throw new TypeError('removeEventListener needs two arguments.');
    removeListener(state, type, callback, options);
  });
  wrap('dispatchEvent', 1, function (this: EventTarget, event: Event) {
    const state = this === null || this === undefined ? undefined : targets.get(this);
    if (!state) return dispatchNative.call(this, event);
    if (!(event instanceof NativeEvent)) throw new TypeError('Not an Event');
    const existing = events.get(event);
    if (existing && existing.phase !== 0) throw new DOMException('The event is already being dispatched.', 'InvalidStateError');
    return !dispatchNow(this, event).canceled;
  });
}

/** Make a target's events continue to `parent`. */
export function registerTarget(target: EventTarget, parent: () => EventTarget | null): void {
  targets.set(target, { listeners: new Map(), parent });
}

/** Whether a value is a target registered here. */
export function isTarget(value: unknown): boolean {
  return typeof value === 'object' && value !== null && targets.has(value as EventTarget);
}

/** The path an event takes from a target: the target, then its parents. */
function pathFrom(target: EventTarget): EventTarget[] {
  const path: EventTarget[] = [];
  for (let t: EventTarget | null = target; t; t = targets.get(t)?.parent() ?? null) path.push(t);
  return path;
}

/** The listeners one target will run for an event in a phase, as of now. */
function listenersFor(target: EventTarget, event: Event, phase: 'capture' | 'bubble'): Listener[] {
  const list = targets.get(target)?.listeners.get(event.type);
  if (!list || !list.length) return [];
  return list.filter((l) => (phase === 'capture' ? l.capture : !l.capture));
}

function call(target: EventTarget, event: Event, state: EventState, listener: Listener): boolean {
  if (listener.removed) return false;
  if (listener.once) removeListener(targets.get(target)!, event.type, listener.callback, { capture: listener.capture });
  state.passive = listener.passive;
  let threw = false;
  try {
    const callback = listener.callback;
    if (typeof callback === 'function') {
      callback.call(target, event);
    } else {
      const handle = callback.handleEvent;
      if (typeof handle !== 'function') throw new TypeError('handleEvent is not a function');
      handle.call(callback, event);
    }
  } catch (error) {
    threw = true;
    reportException(error);
  }
  state.passive = false;
  return threw;
}

/** The (target, phase, capture?) steps of a dispatch, in order. */
function steps(target: EventTarget, event: Event, path: EventTarget[]): [EventTarget, number, 'capture' | 'bubble'][] {
  const out: [EventTarget, number, 'capture' | 'bubble'][] = [];
  for (let i = path.length - 1; i > 0; i--) out.push([path[i], 1, 'capture']);
  out.push([target, 2, 'capture'], [target, 2, 'bubble']);
  if (event.bubbles) for (let i = 1; i < path.length; i++) out.push([path[i], 3, 'bubble']);
  return out;
}

/** Dispatch synchronously, as `dispatchEvent` must. */
function dispatchNow(target: EventTarget, event: Event): Dispatched {
  const state = prepare(event);
  const path = pathFrom(target);
  state.target = target;
  state.path = path;
  state.stopImmediate = false;
  let threw = false;
  for (const [t, phase, which] of steps(target, event, path)) {
    if (cancelBubble.call(event)) break;
    state.phase = phase;
    state.currentTarget = t;
    for (const listener of listenersFor(t, event, which)) {
      threw = call(t, event, state, listener) || threw;
      if (state.stopImmediate) break;
    }
  }
  state.phase = 0;
  state.currentTarget = null;
  return { threw, canceled: event.defaultPrevented };
}

/**
 * Whether dispatching an event of this type at a target would call anything:
 * a listener on the target, or on a parent — a capturing one, or any if the
 * event bubbles. An event nobody would hear need not be dispatched.
 */
export function hasListeners(target: EventTarget, type: string, bubbles: boolean): boolean {
  const path = pathFrom(target);
  for (let i = 0; i < path.length; i++) {
    const list = targets.get(path[i])?.listeners.get(type);
    if (!list || !list.length) continue;
    if (i === 0 || bubbles || list.some((l) => l.capture)) return true;
  }
  return false;
}

let activity = 0;

/** Note that a site called into IndexedDB, which keeps `drain` going. */
export function noteActivity(): void {
  activity++;
}

/**
 * Let the microtasks a listener left run, as the platform's microtask
 * checkpoint would. There is no way to see the microtask queue empty, so
 * this waits through a stretch of microtask turns, and another for as long
 * as the last one saw IndexedDB being used — a promise chain still working
 * with the transaction, which a checkpoint would have let finish.
 */
async function drain(): Promise<void> {
  for (let stretch = 0; stretch < 64; stretch++) {
    const before = activity;
    for (let i = 0; i < 16; i++) await null;
    if (activity === before) return;
  }
}

let checkpoint: () => void = () => {};

/**
 * What to do at the end of the microtask checkpoint that follows each
 * listener: the spec's "cleanup Indexed Database transactions".
 */
export function onCheckpoint(fn: () => void): void {
  checkpoint = fn;
}

/**
 * Dispatch an event the engine fires, letting microtasks run between
 * listeners. Resolves once every listener has run.
 */
export async function dispatch(target: EventTarget, event: Event): Promise<Dispatched> {
  const state = prepare(event);
  const path = pathFrom(target);
  state.target = target;
  state.path = path;
  state.stopImmediate = false;
  let threw = false;
  for (const [t, phase, which] of steps(target, event, path)) {
    if (cancelBubble.call(event)) break;
    const listeners = listenersFor(t, event, which);
    if (!listeners.length) continue;
    for (const listener of listeners) {
      if (listener.removed) continue;
      state.phase = phase;
      state.currentTarget = t;
      threw = call(t, event, state, listener) || threw;
      // What the platform does after each callback it makes from a task.
      await drain();
      checkpoint();
      if (state.stopImmediate) break;
    }
    if (state.stopImmediate) break;
  }
  state.phase = 0;
  state.currentTarget = null;
  return { threw, canceled: event.defaultPrevented };
}

/**
 * Give a prototype `on<type>` event handler attributes: a setter that keeps
 * one listener in its first position, as the HTML spec's event handlers do,
 * and a handler whose `false` return cancels the event. Reading or writing
 * one on anything but an instance of the interface is a TypeError.
 */
export function defineHandlers(proto: object, types: string[], isInstance: (value: unknown) => boolean): void {
  const handlers = new WeakMap<object, Map<string, { value: unknown; listener: EventListener }>>();
  for (const type of types) {
    const get = function (this: EventTarget) {
      if (!isInstance(this)) throw new TypeError('Illegal invocation');
      return handlers.get(this)?.get(type)?.value ?? null;
    };
    const set = function (this: EventTarget, value: unknown) {
      if (!isInstance(this)) throw new TypeError('Illegal invocation');
      let map = handlers.get(this);
      if (!map) {
        map = new Map();
        handlers.set(this, map);
      }
      const slot = map.get(type);
      const next = typeof value === 'function' || (typeof value === 'object' && value !== null) ? value : null;
      const state = targets.get(this)!;
      if (next === null) {
        if (slot) removeListener(state, type, slot.listener, false);
        map.delete(type);
        return;
      }
      if (slot) {
        slot.value = next;
        return;
      }
      const entry = { value: next, listener: null as unknown as EventListener };
      entry.listener = function (this: EventTarget, event: Event) {
        const fn = entry.value;
        if (typeof fn !== 'function') return;
        const result = fn.call(this, event);
        if (result === false) event.preventDefault();
      };
      map.set(type, entry);
      addListener(state, this, type, entry.listener, false);
    };
    Object.defineProperty(get, 'name', { value: `get on${type}` });
    Object.defineProperty(set, 'name', { value: `set on${type}` });
    Object.defineProperty(proto, `on${type}`, { get, set, enumerable: true, configurable: true });
  }
}

/** Create an event of a type with bubbles and cancelable set. */
export function makeEvent(type: string, bubbles: boolean, cancelable: boolean): Event {
  return new NativeEvent(type, { bubbles, cancelable });
}

export class IDBVersionChangeEvent extends NativeEvent {
  #oldVersion: number;
  #newVersion: number | null;

  constructor(type: string, init: { oldVersion?: number; newVersion?: number | null; bubbles?: boolean; cancelable?: boolean; composed?: boolean } = {}) {
    if (arguments.length < 1) throw new TypeError('IDBVersionChangeEvent needs a type');
    super(type, init);
    this.#oldVersion = init.oldVersion === undefined ? 0 : toUnsignedLongLong(init.oldVersion);
    this.#newVersion = init.newVersion === undefined || init.newVersion === null ? null : toUnsignedLongLong(init.newVersion);
  }

  get oldVersion(): number {
    return this.#oldVersion;
  }

  get newVersion(): number | null {
    return this.#newVersion;
  }
}

function toUnsignedLongLong(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const t = Math.trunc(n);
  return t < 0 ? 0 : t;
}

/**
 * Run a function as its own task, after the current one and every microtask
 * it leaves. A MessageChannel rather than setTimeout: timers are clamped,
 * and an IndexedDB request waits on one of these per event.
 */
export const queueTask: (fn: () => void) => void = (() => {
  if (typeof MessageChannel === 'function') {
    const channel = new MessageChannel();
    const queue: (() => void)[] = [];
    channel.port1.onmessage = () => {
      const fn = queue.shift();
      if (fn) fn();
    };
    return (fn: () => void) => {
      queue.push(fn);
      channel.port2.postMessage(null);
    };
  }
  return (fn: () => void) => {
    setTimeout(fn, 0);
  };
})();

/**
 * Run a function soon, without a task of its own: after the microtasks
 * already queued. What carries a transaction from one event to the next.
 *
 * A task is what the spec gives each event, and what a MessageChannel gives
 * `queueTask` — at a cost, in WebKit, of tens of microseconds a message,
 * which a cursor pays per record. Going on in a microtask instead is only
 * visible to a timer racing IndexedDB's own events; the transaction is still
 * inactive before any other task runs, since each dispatch ends by making it
 * so. A long run of these still yields a task every few milliseconds, so a
 * cursor over a whole store cannot starve the page.
 */
export const soon: (fn: () => void) => void = (() => {
  const queue: (() => void)[] = [];
  let scheduled = false;
  let sliceStart = 0;
  let lastRun = 0;
  const run = () => {
    scheduled = false;
    const fn = queue.shift();
    if (fn) fn();
    lastRun = performance.now();
    if (queue.length) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const now = performance.now();
    // A run that stopped a while ago starts a fresh slice.
    if (now - lastRun > 4) sliceStart = now;
    if (now - sliceStart > 8) {
      sliceStart = now;
      queueTask(run);
    } else {
      queueMicrotask(run);
    }
  };
  return (fn: () => void) => {
    queue.push(fn);
    schedule();
  };
})();

/**
 * Run a function before any task queued after this call — whichever comes
 * first of a timer and a message, since a site's next task might be either.
 * For making a transaction inactive: the spec has that happen at the end of
 * the task that activated it, and a site's `setTimeout(0)` must already see
 * it.
 */
export function beforeNextTask(fn: () => void): void {
  let ran = false;
  const once = () => {
    if (ran) return;
    ran = true;
    fn();
  };
  setTimeout(once, 0);
  queueTask(once);
}
