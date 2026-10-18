import { Component, type ReactNode } from "react";

/** Last resort: a render error shows a way out instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("ParkWhere crashed", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="layout">
        <section className="empty">
          <h1>Something went wrong.</h1>
          <p>ParkWhere hit an unexpected error. Try reloading the page.</p>
          <p>
            <button type="button" className="button button-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </p>
        </section>
      </main>
    );
  }
}
