export function Header() {
  return (
    <header className="header">
      <a className="brand" href="/" aria-label="ParkWhere home">
        <img src="/icons/parkwhere-mark.svg" width="32" height="32" alt="" />
        <span className="wordmark">
          Park<span className="wordmark-where">Where</span>
        </span>
      </a>
      <span className="header-note">Singapore carparks</span>
    </header>
  );
}
