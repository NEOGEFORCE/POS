"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";
import { Info } from "lucide-react";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div className="p-4 border border-rose-500/20 bg-rose-500/10 rounded-2xl flex items-center gap-3 text-rose-500">
          <Info size={24} />
          <div className="flex flex-col">
            <h2 className="font-medium text-sm uppercase">Error en el Formulario</h2>
            <p className="text-xs tracking-tight opacity-80">Por favor, cierra esta ventana e intenta de nuevo. Revisa que los numeros digitados sean validos.</p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
