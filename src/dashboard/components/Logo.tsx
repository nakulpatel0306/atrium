// Painted from docs/brand/logo-mark.svg through a CSS mask (see .logo in styles.css), so the mark takes the
// surrounding text color and swapping the logo means replacing that one file.
export function Logo({ className = "", label }: { className?: string; label?: string }) {
  return label ? (
    <span className={`logo ${className}`} role="img" aria-label={label} />
  ) : (
    <span className={`logo ${className}`} aria-hidden />
  );
}
