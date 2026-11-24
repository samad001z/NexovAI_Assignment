/** The Banyan Clinic mark and name, shared by the patient and staff pages. */
export function Brand({ sub }: { sub: string }) {
  return (
    <div className="brand">
      <span className="brand__mark" aria-hidden>
        <svg viewBox="0 0 28 28" width="22" height="22">
          <path d="M3 11.5C3 7 8 4 14 4s11 3 11 7.5c0 1.4-1.1 2.5-2.5 2.5h-17C4.1 14 3 12.9 3 11.5Z" fill="currentColor" />
          <path d="M14 14v10M9 14v6M19 14v6M5.5 14v3M22.5 14v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <div>
        <b>Banyan Clinic</b>
        <span>{sub}</span>
      </div>
    </div>
  );
}
