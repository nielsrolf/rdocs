export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="r-docs-bg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1a73e8" />
          <stop offset="1" stopColor="#174ea6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#r-docs-bg)" />
      <rect x="8.5" y="11" width="11" height="2" rx="1" fill="#ffffff" />
      <rect x="8.5" y="15.5" width="15" height="2" rx="1" fill="#ffffff" fillOpacity="0.85" />
      <rect x="8.5" y="20" width="8.5" height="2" rx="1" fill="#ffffff" fillOpacity="0.7" />
      <path
        d="M24 6.5 L25.2 9.3 L28 10.5 L25.2 11.7 L24 14.5 L22.8 11.7 L20 10.5 L22.8 9.3 Z"
        fill="#fbbc04"
      />
    </svg>
  );
}
