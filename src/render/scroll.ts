/*
 * Copyright (c) 2022-2026 Datalayer, Inc.
 *
 * MIT License
 */

/**
 * The scroll container's spacer is capped: browsers cap an element's height
 * (about 17.9 M px in Firefox, 33.5 M px in Chromium) and a million rows of
 * 21 px is 22 M px. Above the cap, the DOM scroll position maps linearly onto
 * the sheet; small steps stay exact, so a 1 px scroll is a 1 px scroll.
 *
 * @module render/scroll
 */

/** The largest spacer, CSS px. */
export const SPACER_CAP = 8_000_000;

export interface ScrollAxis {
  /** The content's extent past what the viewport shows (the largest content scroll), sheet px × zoom. */
  readonly maxContent: number;
  /** The viewport's size on this axis, CSS px. */
  readonly viewport: number;
}

/** The spacer's size for a content extent, CSS px. */
export function spacerSize(maxContent: number, viewport: number): number {
  return Math.min(maxContent + viewport, SPACER_CAP);
}

/**
 * Maps DOM scroll positions to content scroll, statefully: a step smaller than
 * the viewport moves the content by exactly that step; a larger one (a
 * scrollbar drag, a jump) maps linearly. The ends map to the ends exactly.
 */
export class ScrollMapper {
  #dom = 0;
  #content = 0;

  /** The content scroll for a new DOM scroll position. */
  map(dom: number, axis: ScrollAxis): number {
    const maxDom = spacerSize(axis.maxContent, axis.viewport) - axis.viewport;
    if (axis.maxContent <= maxDom || maxDom <= 0) {
      this.#dom = dom;
      this.#content = Math.min(Math.max(0, dom), axis.maxContent);
      return this.#content;
    }
    const delta = dom - this.#dom;
    let content: number;
    if (dom <= 0) content = 0;
    else if (dom >= maxDom) content = axis.maxContent;
    else if (Math.abs(delta) < axis.viewport) content = this.#content + delta;
    else content = (dom / maxDom) * axis.maxContent;
    this.#dom = dom;
    this.#content = Math.min(Math.max(0, content), axis.maxContent);
    return this.#content;
  }

  /** The DOM scroll position that shows a content scroll (for scrollTo), and remember it. */
  domFor(content: number, axis: ScrollAxis): number {
    const maxDom = spacerSize(axis.maxContent, axis.viewport) - axis.viewport;
    const dom =
      axis.maxContent <= maxDom || maxDom <= 0 ? content : (content / axis.maxContent) * maxDom;
    this.#dom = dom;
    this.#content = content;
    return dom;
  }

  get content(): number {
    return this.#content;
  }
}
