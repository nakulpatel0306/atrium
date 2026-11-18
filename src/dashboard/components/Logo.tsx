// Plum, resting, where the dashboard has nothing else to show yet (see .logo in styles.css). The Mac app's menu bar
// keeps the line mark in assets/logo-mark.svg.
export function Logo({ className = "", label }: { className?: string; label?: string }) {
  return label ? (
    <span className={`logo ${className}`} role="img" aria-label={label} />
  ) : (
    <span className={`logo ${className}`} aria-hidden />
  );
}
