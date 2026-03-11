/**
 * Svelte action that positions a popover using fixed positioning,
 * ensuring it stays within the viewport and never gets clipped by
 * overflow:auto containers.
 *
 * Usage:
 *   <div class="popover" use:popover>
 *   <div class="popover" use:popover={{ align: 'right' }}>
 *
 * The action automatically finds the trigger element as the previous
 * sibling element, or falls back to the parent element.
 *
 * @param {HTMLElement} node  — the popover element
 * @param {{ align?: 'left'|'right' }} opts
 */
export function popover(node, opts = {}) {
    // The anchor is the previous sibling element (the trigger button)
    // or the parent wrapper if no sibling exists
    const anchor = node.previousElementSibling || node.parentElement;

    function position() {
        if (!anchor) return;

        const rect = anchor.getBoundingClientRect();
        const gap = 6;
        const margin = 8;

        // Measure popover
        const popH = node.offsetHeight;
        const popW = node.offsetWidth;

        // Vertical: prefer below, flip above if it would clip
        const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
        const openAbove = spaceBelow < popH && rect.top - gap > popH;
        let top;

        if (openAbove) {
            top = rect.top - gap - popH;
        } else {
            top = rect.bottom + gap;
        }

        // Clamp vertically when the popover is taller than the available space.
        top = Math.max(margin, Math.min(top, window.innerHeight - popH - margin));
        node.style.top = `${top}px`;

        // Horizontal: align to left or right edge of anchor, clamp to viewport
        const align = opts?.align || 'left';
        let left;
        if (align === 'right') {
            left = rect.right - popW;
        } else {
            left = rect.left;
        }

        // Clamp to viewport edges with 8px margin
        left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
        node.style.left = `${left}px`;
    }

    // Position on mount
    requestAnimationFrame(position);
    requestAnimationFrame(position);

    // Reposition on scroll/resize
    const scrollHandler = () => requestAnimationFrame(position);
    window.addEventListener('scroll', scrollHandler, true);
    window.addEventListener('resize', scrollHandler);
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(position));
    resizeObserver.observe(node);

    return {
        update(newOpts) {
            opts = newOpts;
            position();
        },
        destroy() {
            window.removeEventListener('scroll', scrollHandler, true);
            window.removeEventListener('resize', scrollHandler);
            resizeObserver.disconnect();
        }
    };
}
