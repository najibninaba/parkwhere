/** Placeholder cards with the shape of real results, shown while the first results load. */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <ol className="list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="card card-skeleton">
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-sub" />
          <span className="skeleton-block" />
        </li>
      ))}
    </ol>
  );
}
