/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * An axis of a sheet: its rows, or its columns.
 *
 * - **Ids.** Every index has a stable id that follows the row through inserts,
 *   deletes and moves. Ids are materialised only up to the last index ever
 *   named; beyond, an index has an *implicit* id derived from where the row
 *   was when the axis was created (`IMPLICIT_BASE + creation index`), so two
 *   replicas that materialise the same index independently agree on its id.
 *   Inserted indexes get fresh ids, from `FRESH_BASE` up.
 * - **Sizes.** Default until the first resize; then a raw `Float64Array` of
 *   sizes and a Fenwick tree over the effective sizes (0 when hidden), so
 *   `offsetOf` and `indexAt` are O(log n) and a resize is O(log n). An insert
 *   or delete rebuilds the tree from the edit point only.
 * - **Hidden** is a bitset beside the sizes: a hidden index keeps its size for
 *   unhide and contributes 0 to offsets.
 *
 * @module core/axis
 */

/** Implicit ids are `IMPLICIT_BASE + creation index`. */
export const IMPLICIT_BASE = 0;
/** Fresh ids (inserted indexes) start here, above any creation index. */
export const FRESH_BASE = 1 << 30;

/** The state of a run of indexes, as patches carry it. */
export interface AxisSegment {
  readonly ids: Int32Array;
  /** `null`: every size is the default. */
  readonly sizes: Float64Array | null;
  /** `null`: none is hidden; else 1 per hidden index. */
  readonly hidden: Uint8Array | null;
}

export interface AxisOptions {
  /** The logical number of indexes (1,048,576 rows, 16,384 columns in Excel). */
  readonly count: number;
  /** The size of an index nobody resized, in CSS px. */
  readonly defaultSize: number;
}

export class Axis {
  readonly count: number;
  readonly defaultSize: number;

  /** Materialised ids, `[0, #length)`; the buffer grows by doubling. */
  #ids: Int32Array = new Int32Array(0);
  #length = 0;
  /** The creation index of the first implicit index (`#length`). */
  #implicitStart = 0;
  #nextFresh = FRESH_BASE;

  /** `null` until the first non-default size or hidden index. */
  #sizes: Float64Array | null = null;
  #tree: Float64Array | null = null;
  #hidden: Uint32Array | null = null;

  constructor(options: AxisOptions) {
    if (!Number.isInteger(options.count) || options.count < 1 || options.count > FRESH_BASE - 1) {
      throw new Error(
        `An axis holds 1 to ${FRESH_BASE - 1} indexes; ${options.count} was asked for.`,
      );
    }
    if (!(options.defaultSize > 0)) {
      throw new Error(`An axis's default size must be positive; ${options.defaultSize} was given.`);
    }
    this.count = options.count;
    this.defaultSize = options.defaultSize;
  }

  // ---------------------------------------------------------------- ids

  /** The id of an index, materialised or implicit. */
  idAt(index: number): number {
    this.#check(index);
    if (index < this.#length) return this.#ids[index];
    return IMPLICIT_BASE + this.#implicitStart + (index - this.#length);
  }

  /**
   * Materialise ids up to `index` inclusive and return its id. Anything that
   * names an index (content, a size, a merge corner, a reference) calls this
   * first, so no implicit id is ever referenced.
   */
  materialize(index: number): number {
    this.#check(index);
    if (index >= this.#length) {
      const n = index + 1 - this.#length;
      this.#reserve(index + 1);
      for (let k = 0; k < n; k += 1)
        this.#ids[this.#length + k] = IMPLICIT_BASE + this.#implicitStart + k;
      this.#implicitStart += n;
      this.#length = index + 1;
    }
    return this.#ids[index];
  }

  /** How many ids are materialised. */
  get materialized(): number {
    return this.#length;
  }

  /** `n` fresh ids, for the indexes an insert creates. Never reused. */
  freshIds(n: number): Int32Array {
    const ids = new Int32Array(n);
    for (let k = 0; k < n; k += 1) ids[k] = this.#nextFresh++;
    return ids;
  }

  /** Whether `tail` is what a delete of `n` would bring at the end by itself. */
  #isImplicitTail(tail: AxisSegment, n: number): boolean {
    if (tail.sizes !== null || tail.hidden !== null) return false;
    // After the delete, `#length` drops by n and index k >= #length holds
    // IMPLICIT_BASE + #implicitStart + (k - #length).
    const lengthAfter = this.#length - n;
    for (let k = 0; k < n; k += 1) {
      const index = this.count - n + k;
      if (index < lengthAfter) return false;
      if (tail.ids[k] !== IMPLICIT_BASE + this.#implicitStart + (index - lengthAfter)) return false;
    }
    return true;
  }

  /** The index of an id, or -1. O(n) over the materialised ids; for the binding, not the hot path. */
  indexOfId(id: number): number {
    for (let i = 0; i < this.#length; i += 1) if (this.#ids[i] === id) return i;
    if (id >= IMPLICIT_BASE + this.#implicitStart && id < FRESH_BASE) {
      const index = this.#length + (id - IMPLICIT_BASE - this.#implicitStart);
      return index < this.count ? index : -1;
    }
    return -1;
  }

  /** A copy of the materialised ids, for snapshots and the file format. */
  ids(): Int32Array {
    return this.#ids.slice(0, this.#length);
  }

  // ---------------------------------------------------------------- structure

  /** The state of `n` indexes from `at`: ids, sizes and hidden flags, for patches. */
  segment(at: number, n: number): AxisSegment {
    this.#checkSpan(at, n, false);
    return {
      ids: Int32Array.from({ length: n }, (_, k) => this.idAt(at + k)),
      sizes: this.#sizes === null ? null : this.#sizes.slice(at, at + n),
      hidden:
        this.#hidden === null
          ? null
          : Uint8Array.from({ length: n }, (_, k) => (this.isHidden(at + k) ? 1 : 0)),
    };
  }

  /**
   * Insert `n` indexes before `at`. The count stays: the last `n` indexes fall
   * off the end (the command checks they are empty), and come back as
   * `dropped`. With `segment`, the inserted indexes take its ids, sizes and
   * hidden flags (undo, redo, remote inserts); without, fresh ids and the
   * default size.
   */
  insert(
    at: number,
    n: number,
    segment?: AxisSegment,
  ): { inserted: AxisSegment; dropped: AxisSegment } {
    this.#checkSpan(at, n, true);
    if (segment !== undefined && segment.ids.length !== n) {
      throw new Error(`insert: ${n} indexes but a segment of ${segment.ids.length}.`);
    }
    const dropped = this.segment(this.count - n, n);
    let ids: Int32Array;
    if (segment !== undefined) ids = segment.ids.slice();
    else {
      ids = new Int32Array(n);
      for (let k = 0; k < n; k += 1) ids[k] = this.#nextFresh++;
    }
    if (at > this.#length) this.materialize(at - 1);
    this.#reserve(Math.min(this.#length + n, this.count));
    this.#ids.copyWithin(at + n, at, Math.min(this.#length, this.count - n));
    this.#ids.set(ids, at);
    this.#length = Math.min(this.#length + n, this.count);
    const needsSizes = this.#sizes !== null || segment?.sizes != null || segment?.hidden != null;
    if (needsSizes) {
      this.#allocate();
      const sizes = this.#sizes!;
      sizes.copyWithin(at + n, at, this.count - n);
      if (segment?.sizes) sizes.set(segment.sizes, at);
      else sizes.fill(this.defaultSize, at, at + n);
      if (this.#hidden !== null || segment?.hidden) {
        if (this.#hidden === null) this.#hidden = new Uint32Array(Math.ceil(this.count / 32));
        shiftBits(this.#hidden, this.count, at, n);
        if (segment?.hidden)
          for (let k = 0; k < n; k += 1) if (segment.hidden[k]) this.#setBit(at + k, true);
      }
      this.#rebuildFrom(at);
    }
    return {
      inserted: { ids, sizes: segment?.sizes ?? null, hidden: segment?.hidden ?? null },
      dropped,
    };
  }

  /**
   * Delete `n` indexes from `at`; returns them. New indexes appear at the end:
   * implicit ones, or `tail`'s when given (undoing an insert brings back the
   * indexes it pushed off).
   */
  delete(at: number, n: number, tail?: AxisSegment): AxisSegment {
    this.#checkSpan(at, n, false);
    if (tail !== undefined && tail.ids.length !== n) {
      throw new Error(`delete: ${n} indexes but a tail of ${tail.ids.length}.`);
    }
    const removed = this.segment(at, n);
    this.materialize(at + n - 1);
    // A tail that is what the axis would derive anyway (the common case:
    // undoing an insert far from the end) needs no materialising.
    const explicitTail = tail !== undefined && !this.#isImplicitTail(tail, n);
    if (explicitTail) this.materialize(this.count - 1);
    this.#ids.copyWithin(at, at + n, this.#length);
    this.#length -= n;
    if (explicitTail) {
      this.#ids.set(tail!.ids, this.count - n);
      this.#length = this.count;
    }
    const needsSizes = this.#sizes !== null || tail?.sizes != null || tail?.hidden != null;
    if (needsSizes) {
      this.#allocate();
      const sizes = this.#sizes!;
      sizes.copyWithin(at, at + n, this.count);
      if (tail?.sizes) sizes.set(tail.sizes, this.count - n);
      else sizes.fill(this.defaultSize, this.count - n, this.count);
      if (this.#hidden !== null || tail?.hidden) {
        if (this.#hidden === null) this.#hidden = new Uint32Array(Math.ceil(this.count / 32));
        shiftBits(this.#hidden, this.count, at, -n);
        if (tail?.hidden)
          for (let k = 0; k < n; k += 1) if (tail.hidden[k]) this.#setBit(this.count - n + k, true);
      }
      this.#rebuildFrom(at);
    }
    return removed;
  }

  /**
   * Move `n` indexes from `at` to before `to` (an index in the coordinates
   * before the move, outside `[at, at + n]`). Ids, sizes and hidden flags travel.
   */
  move(at: number, n: number, to: number): void {
    this.#checkSpan(at, n, false);
    if (!Number.isInteger(to) || to < 0 || to > this.count || (to >= at && to <= at + n)) {
      throw new Error(`Cannot move ${n} index(es) at ${at} to ${to}.`);
    }
    const lo = Math.min(at, to);
    const hi = Math.max(at + n, to);
    this.materialize(hi - 1);
    const rotate = <A extends Int32Array | Float64Array>(arr: A) => {
      const part = arr.slice(at, at + n);
      if (to < at) {
        arr.copyWithin(to + n, to, at);
        arr.set(part, to);
      } else {
        arr.copyWithin(at, at + n, to);
        arr.set(part, to - n);
      }
    };
    rotate(this.#ids);
    if (this.#sizes !== null) {
      rotate(this.#sizes);
      if (this.#hidden !== null) {
        const flags = Float64Array.from({ length: this.count }, (_, i) =>
          i >= lo && i < hi && this.isHidden(i) ? 1 : 0,
        );
        rotate(flags);
        for (let i = lo; i < hi; i += 1) this.#setBit(i, flags[i] === 1);
      }
      this.#rebuildFrom(lo);
    }
  }

  /** Set sizes and hidden flags of `n` indexes from `at` at once (patches). */
  setSegmentSizes(
    at: number,
    sizes: Float64Array | null,
    hidden: Uint8Array | null,
    n: number,
  ): void {
    this.#checkSpan(at, n, false);
    if (sizes === null && hidden === null && this.#sizes === null) return;
    this.#allocate();
    if (sizes) this.#sizes!.set(sizes, at);
    else this.#sizes!.fill(this.defaultSize, at, at + n);
    if (hidden || this.#hidden !== null) {
      if (this.#hidden === null) this.#hidden = new Uint32Array(Math.ceil(this.count / 32));
      for (let k = 0; k < n; k += 1) this.#setBit(at + k, hidden ? hidden[k] === 1 : false);
    }
    this.#rebuildFrom(at);
  }

  // ---------------------------------------------------------------- sizes

  /** The size of an index as set, hidden or not. */
  sizeOf(index: number): number {
    this.#check(index);
    return this.#sizes === null ? this.defaultSize : this.#sizes[index];
  }

  /** The size an index takes on screen: 0 when hidden. */
  effectiveSizeOf(index: number): number {
    return this.isHidden(index) ? 0 : this.sizeOf(index);
  }

  /** Set the size of an index. O(log n). */
  resize(index: number, size: number): void {
    this.#check(index);
    if (!(size > 0) || !Number.isFinite(size))
      throw new Error(`A size must be positive; ${size} was given.`);
    this.#allocate();
    const before = this.effectiveSizeOf(index);
    this.#sizes![index] = size;
    const after = this.effectiveSizeOf(index);
    if (after !== before) this.#add(index, after - before);
  }

  /** Whether any size was ever set (else every size is the default and nothing is hidden). */
  get customized(): boolean {
    return this.#sizes !== null;
  }

  /** Whether any index is hidden. */
  get hasHidden(): boolean {
    return this.#hidden !== null && this.#hidden.some((w) => w !== 0);
  }

  isHidden(index: number): boolean {
    this.#check(index);
    const h = this.#hidden;
    return h !== null && (h[index >>> 5] & (1 << (index & 31))) !== 0;
  }

  setHidden(index: number, hidden: boolean): void {
    if (this.isHidden(index) === hidden) return;
    this.#allocate();
    if (this.#hidden === null) this.#hidden = new Uint32Array(Math.ceil(this.count / 32));
    const size = this.#sizes![index];
    if (hidden) this.#hidden[index >>> 5] |= 1 << (index & 31);
    else this.#hidden[index >>> 5] &= ~(1 << (index & 31));
    this.#add(index, hidden ? -size : size);
  }

  /** The offset of an index's start: the sum of the effective sizes before it. O(log n). */
  offsetOf(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index > this.count) {
      throw new Error(`No offset at index ${index} of an axis of ${this.count}.`);
    }
    if (this.#tree === null) return index * this.defaultSize;
    let sum = 0;
    for (let i = index; i > 0; i -= i & -i) sum += this.#tree[i];
    return sum;
  }

  /** The total extent of the axis. */
  get extent(): number {
    return this.offsetOf(this.count);
  }

  /** The index under an offset: the last index whose start is at or before it. O(log n). */
  indexAt(offset: number): number {
    if (offset <= 0) return this.#firstVisibleFrom(0);
    if (this.#tree === null) return Math.min(Math.floor(offset / this.defaultSize), this.count - 1);
    const tree = this.#tree;
    let pos = 0;
    let rest = offset;
    for (let step = highestPowerOfTwo(this.count); step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.count && tree[next] <= rest) {
        pos = next;
        rest -= tree[next];
      }
    }
    // `pos` indexes end at or before the offset; the one under it is `pos`,
    // or the last index when the offset is past the end.
    return Math.min(pos, this.count - 1);
  }

  // ---------------------------------------------------------------- internals

  #firstVisibleFrom(index: number): number {
    let i = index;
    while (i < this.count - 1 && this.effectiveSizeOf(i) === 0) i += 1;
    return i;
  }

  #allocate(): void {
    if (this.#sizes !== null) return;
    this.#sizes = new Float64Array(this.count).fill(this.defaultSize);
    this.#tree = new Float64Array(this.count + 1);
    this.#rebuildFrom(0);
  }

  #setBit(index: number, on: boolean): void {
    const h = this.#hidden!;
    if (on) h[index >>> 5] |= 1 << (index & 31);
    else h[index >>> 5] &= ~(1 << (index & 31));
  }

  #add(index: number, delta: number): void {
    const tree = this.#tree!;
    for (let i = index + 1; i <= this.count; i += i & -i) tree[i] += delta;
  }

  /**
   * Recompute the Fenwick nodes covering indexes `>= from`, in one pass:
   * node i holds prefix(i) - prefix(i - lowbit(i)); prefixes below `from`
   * come from the still-valid lower nodes, those above from a running sum.
   */
  #rebuildFrom(from: number): void {
    const tree = this.#tree!;
    const n = this.count;
    const start = from + 1;
    const below = this.#prefixFromTree(from);
    const running = new Float64Array(n - from + 1);
    running[0] = below;
    let sum = below;
    for (let i = start; i <= n; i += 1) {
      sum += this.effectiveSizeOf(i - 1);
      running[i - from] = sum;
      const lower = i - (i & -i);
      const lowerPrefix = lower >= from ? running[lower - from] : this.#prefixFromTree(lower);
      tree[i] = sum - lowerPrefix;
    }
  }

  #prefixFromTree(index: number): number {
    const tree = this.#tree!;
    let sum = 0;
    for (let i = index; i > 0; i -= i & -i) sum += tree[i];
    return sum;
  }

  #reserve(length: number): void {
    if (length <= this.#ids.length) return;
    let capacity = Math.max(64, this.#ids.length);
    while (capacity < length) capacity *= 2;
    const ids = new Int32Array(Math.min(capacity, this.count + 1));
    ids.set(this.#ids.subarray(0, this.#length));
    this.#ids = ids;
  }

  #check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new Error(`Index ${index} is outside an axis of ${this.count}.`);
    }
  }

  #checkSpan(at: number, n: number, inserting: boolean): void {
    if (!Number.isInteger(n) || n < 1)
      throw new Error(`A span needs at least one index; ${n} was given.`);
    if (!Number.isInteger(at) || at < 0 || at + n > this.count || (inserting && at >= this.count)) {
      throw new Error(`${n} index(es) at ${at} do not fit an axis of ${this.count}.`);
    }
  }
}

function highestPowerOfTwo(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/** Shift the bits at and after `at` by `n` (negative: towards `at`, dropping `-n` bits). */
function shiftBits(bits: Uint32Array, count: number, at: number, n: number): void {
  const get = (i: number) => (bits[i >>> 5] & (1 << (i & 31))) !== 0;
  const set = (i: number, v: boolean) => {
    if (v) bits[i >>> 5] |= 1 << (i & 31);
    else bits[i >>> 5] &= ~(1 << (i & 31));
  };
  if (n > 0) {
    for (let i = count - 1; i >= at + n; i -= 1) set(i, get(i - n));
    for (let i = at; i < at + n; i += 1) set(i, false);
  } else {
    const m = -n;
    for (let i = at; i < count - m; i += 1) set(i, get(i + m));
    for (let i = count - m; i < count; i += 1) set(i, false);
  }
}
