/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * Reading Reactor contribution points the way a spreadsheet must: once, into
 * an indexed table, rebuilt only when the platform changed.
 *
 * Reading a point is an activation event and returns a fresh array; the
 * evaluator and the renderer cannot pay that per cell or per frame. A
 * {@link PointTable} keeps the last resolution and the platform revision it
 * was made at, and resolves again only when the revision moved.
 *
 * @module points/resolve
 */

import type { Contribution, ContributionPoint, ReactorPlatformView } from '@datalayer/reactor';

/** The platform as a table reads it: contributions, and the revision that dates them. */
export type CellsPlatform = ReactorPlatformView & { getRevision: () => number };

/** A contribution as a table keeps it: the value, and who contributed it. */
export interface Resolved<T> {
  readonly value: T;
  readonly plugin: string;
  readonly id: string;
}

export interface PointTableOptions<T> {
  /** What the point is, in words, for the refusals ("formula function"). */
  readonly label: string;
  /** The key a contribution is found by (a function's upper-cased name, a command's type). */
  readonly key: (value: T) => string;
  /** Checks a contribution's shape; throws a sentence when it is wrong. */
  readonly check?: (value: T) => void;
}

/**
 * A point resolved into a `Map` by key. A key contributed twice is refused
 * with a sentence naming both plugins: two plugins fighting over one name is
 * a bug, and the loser would otherwise fail invisibly.
 */
export class PointTable<T> {
  readonly #platform: CellsPlatform;
  readonly #point: ContributionPoint<T>;
  readonly #options: PointTableOptions<T>;
  #revision = -1;
  #byKey = new Map<string, Resolved<T>>();
  #ordered: Resolved<T>[] = [];

  constructor(platform: CellsPlatform, point: ContributionPoint<T>, options: PointTableOptions<T>) {
    this.#platform = platform;
    this.#point = point;
    this.#options = options;
  }

  /** The contribution of that key, or `undefined`. */
  get(key: string): Resolved<T> | undefined {
    this.#refresh();
    return this.#byKey.get(key);
  }

  /** Every contribution, in Reactor's order (`order`, then contribution order). */
  all(): readonly Resolved<T>[] {
    this.#refresh();
    return this.#ordered;
  }

  keys(): IterableIterator<string> {
    this.#refresh();
    return this.#byKey.keys();
  }

  /** The platform revision the table was last resolved at. */
  get revision(): number {
    this.#refresh();
    return this.#revision;
  }

  #refresh(): void {
    const revision = this.#platform.getRevision();
    if (revision === this.#revision) return;
    const contributions = this.#platform.getContributions(this.#point);
    const byKey = new Map<string, Resolved<T>>();
    const ordered: Resolved<T>[] = [];
    for (const c of contributions) {
      const resolved = checked(c, this.#options);
      const key = this.#options.key(c.value);
      const taken = byKey.get(key);
      if (taken !== undefined) {
        throw new Error(
          `The ${this.#options.label} '${key}' is contributed twice to ${this.#point.id}: ` +
            `by ${taken.plugin} (id '${taken.id}') and by ${c.plugin} (id '${c.id}'). ` +
            `Disable one of the two plugins, or rename one ${this.#options.label}.`,
        );
      }
      byKey.set(key, resolved);
      ordered.push(resolved);
    }
    // The read itself may have woken lazy plugins, which bumps the revision on
    // a microtask: record the revision read *before* that, so their
    // contributions are picked up on the next access.
    this.#revision = revision;
    this.#byKey = byKey;
    this.#ordered = ordered;
  }
}

function checked<T>(c: Contribution<T>, options: PointTableOptions<T>): Resolved<T> {
  if (options.check) {
    try {
      options.check(c.value);
    } catch (error) {
      throw new Error(
        `${c.plugin} contributes a malformed ${options.label} (id '${c.id}'): ${(error as Error).message}`,
      );
    }
  }
  return { value: c.value, plugin: c.plugin, id: c.id };
}

/**
 * The one contribution of a point that must have exactly one winner: the
 * first by `order`. None is refused, and so is a tie at the winning `order`
 * (two providers with equal claim), as personal-agent-protocol's
 * `firstContribution` does.
 */
export function firstContribution<T>(
  platform: ReactorPlatformView,
  point: ContributionPoint<T>,
  label: string,
): Resolved<T> {
  const found = optionalContribution(platform, point, label);
  if (found === undefined) {
    throw new Error(`No plugin contributes a ${label} (${point.id}).`);
  }
  return found;
}

/** Like {@link firstContribution}, but none is allowed: the feature is off. A tie is still refused. */
export function optionalContribution<T>(
  platform: ReactorPlatformView,
  point: ContributionPoint<T>,
  label: string,
): Resolved<T> | undefined {
  const contributions = platform.getContributions(point);
  const [first, second] = contributions;
  if (first === undefined) return undefined;
  if (second !== undefined && second.order === first.order) {
    throw new Error(
      `Two plugins contribute a ${label} (${point.id}) at the same order ${first.order}: ` +
        `${first.plugin} (id '${first.id}') and ${second.plugin} (id '${second.id}'). ` +
        `Give one a lower order, or disable one.`,
    );
  }
  return { value: first.value, plugin: first.plugin, id: first.id };
}
