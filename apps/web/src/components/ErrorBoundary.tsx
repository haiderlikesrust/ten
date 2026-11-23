"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Told about each crash, to show it to the user. */
  onError?: (error: Error) => void;
  /** Shown while the part is down. Nothing by default, so the rest of the page carries on. */
  fallback?: ReactNode;
  /** Tries the part again after a crash, this many times a minute, so a one-off error heals by itself. */
  retries?: number;
}

interface State {
  failed: boolean;
}

/**
 * Keeps a crash in one part of the page from taking the whole site down. React otherwise unmounts everything on an
 * error during rendering and shows "Application error: a client-side exception has occurred". Privy's wallet
 * screens render inside the site, so an error in one of them used to blank tenner.trade.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };
  private crashes: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("A part of the page crashed and was contained:", error);
    this.props.onError?.(error);
    const now = Date.now();
    this.crashes = [...this.crashes.filter((at) => now - at < 60_000), now];
    // A part that keeps crashing stays down instead of looping.
    if (this.crashes.length <= (this.props.retries ?? 0)) this.timer = setTimeout(() => this.setState({ failed: false }), 800);
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
