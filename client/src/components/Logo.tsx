import { cx } from '@/lib/format';

/**
 * The DHYEYA logo lock-up.
 *
 * Both assets are rendered at their native 1:1 aspect ratio and never stretched,
 * cropped or recoloured. `dhyeya-logo.jpeg` is the supplied original, used wherever
 * the wordmark has room to be read. `dhyeya-mark.png` is a separate transparent
 * asset derived from it for the places a square mark is needed — the collapsed
 * sidebar rail and the browser tab — rather than squeezing the full lock-up into a
 * space where its wordmark would be illegible.
 */

export function LogoFull({ className, width = 150 }: { className?: string; width?: number }) {
  return (
    <img
      src="/dhyeya-logo.jpeg"
      alt="DHYEYA — Business and Executive Dashboard"
      width={width}
      height={width}
      className={cx('object-contain select-none', className)}
      style={{ width, height: width, aspectRatio: '1 / 1' }}
      draggable={false}
    />
  );
}

export function LogoMark({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <img
      src="/dhyeya-mark.png"
      alt="DHYEYA"
      width={size}
      height={size}
      className={cx('object-contain select-none', className)}
      style={{ width: size, height: size, aspectRatio: '1 / 1' }}
      draggable={false}
    />
  );
}

/**
 * The mark beside the product name, for headers where a square lock-up would be
 * too tall. The wordmark is set in Inter rather than cut out of the logo image, so
 * the supplied asset is never altered.
 */
export function LogoHorizontal({ className, markSize = 34 }: { className?: string; markSize?: number }) {
  return (
    <div className={cx('flex items-center gap-2.5 min-w-0', className)}>
      <LogoMark size={markSize} />
      <div className="min-w-0 leading-none">
        <div className="text-base font-bold tracking-tight text-navy-900">DHYEYA</div>
        {/* Set at a size the full strapline fits, rather than truncating the brand name. */}
        <div className="text-[7.5px] font-medium tracking-[0.09em] text-ink-muted uppercase mt-1 whitespace-nowrap">
          Business and Executive Dashboard
        </div>
      </div>
    </div>
  );
}
