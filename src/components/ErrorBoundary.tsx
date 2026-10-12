import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import i18n from '@/i18n'
import { Button } from './ui/button'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an unhandled render error:', error, errorInfo)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-background p-6 text-foreground">
          <div className="flex max-w-lg flex-col items-center gap-4 rounded-xl border bg-card p-6 text-center shadow-lg">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="size-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{i18n.t('common:render.crashTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {i18n.t('common:render.crashBody')}
              </p>
            </div>
            {this.state.error && (
              <pre className="max-h-36 w-full overflow-auto rounded-md bg-muted p-3 text-left font-mono text-xs text-destructive">
                {this.state.error.stack || this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3">
              <Button size="sm" onClick={this.handleReload}>
                <RefreshCw className="mr-1.5 size-4" />
                {i18n.t('common:render.reloadPage')}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
