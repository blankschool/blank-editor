import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { shouldLogError } from "./errorDedupe";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const key = `${error.message}\n${info.componentStack ?? ""}`;
    if (shouldLogError(key)) {
      console.error("[ErrorBoundary] erro não tratado no console:", error, info.componentStack);
    }
  }

  private reload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-lg font-medium">Algo deu errado.</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Ocorreu um erro inesperado nesta tela. Você pode tentar recarregar a página.
          </p>
          <Button onClick={this.reload}>Recarregar</Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function installGlobalErrorLogging() {
  window.addEventListener("error", (event) => {
    const key = `window.error:${event.message}\n${event.filename}:${event.lineno}`;
    if (shouldLogError(key)) {
      console.error("[GlobalError] erro não capturado:", event.error ?? event.message);
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const key = `unhandledrejection:${reason instanceof Error ? reason.message : String(reason)}`;
    if (shouldLogError(key)) {
      console.error("[GlobalError] promise rejeitada sem tratamento:", reason);
    }
  });
}
