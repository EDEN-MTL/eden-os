import { Component, ReactNode } from "react";

/**
 * If drawing the report throws (a shape nobody planned for), show a plain message and a way back instead of a blank
 * page. The rest of the console keeps working.
 */
export default class LensBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[LENS-UI] The report could not be drawn:", error instanceof Error ? error.message : error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="lens">
        <div className="lens-banner is-error" role="alert">
          <strong>Something went wrong drawing this report.</strong>
          <span>Nothing was changed. Try again; if it keeps happening, tell the Eden team what you had selected.</span>
          <button type="button" className="lens-button" onClick={() => this.setState({ failed: false })}>Try again</button>
        </div>
      </div>
    );
  }
}
