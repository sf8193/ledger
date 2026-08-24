export function LedgerLogo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Book spine */}
      <path
        d="M12 4C12 4 6 3 3 4V19C6 18 12 19 12 19C12 19 18 18 21 19V4C18 3 12 4 12 4Z"
        stroke="#64748b"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Center spine line */}
      <line x1="12" y1="4" x2="12" y2="19" stroke="#64748b" strokeWidth="1.5" />

      {/* Left page — green lines (income/credits) */}
      <line x1="5.5" y1="8" x2="10" y2="8" stroke="#10b981" strokeWidth="1" strokeLinecap="round" />
      <line x1="5.5" y1="11" x2="10" y2="11" stroke="#10b981" strokeWidth="1" strokeLinecap="round" />
      <line x1="5.5" y1="14" x2="9" y2="14" stroke="#10b981" strokeWidth="1" strokeLinecap="round" />

      {/* Right page — red lines (expenses/debits) */}
      <line x1="14" y1="8" x2="18.5" y2="8" stroke="#ef4444" strokeWidth="1" strokeLinecap="round" />
      <line x1="14" y1="11" x2="18.5" y2="11" stroke="#ef4444" strokeWidth="1" strokeLinecap="round" />
      <line x1="15" y1="14" x2="18.5" y2="14" stroke="#ef4444" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
