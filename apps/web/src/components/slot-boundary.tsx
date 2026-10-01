'use client';
import { Component, type ReactNode } from 'react';

/**
 * A slot is third-party-ish UI inside a Base page. If it throws (while rendering, on the server or the client), the page
 * must survive: this renders nothing for that slot instead of taking the whole page to the error screen.
 */
export class SlotBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error(`extension slot "${this.props.label}" failed`, error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
