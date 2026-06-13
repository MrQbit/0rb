declare const MACRO: {
  VERSION: string
  DISPLAY_VERSION?: string
  PACKAGE_URL?: string
  ISSUES_EXPLAINER?: string
  BUILD_TIME?: string
  VERSION_CHANGELOG?: string
  IS_STANDALONE?: boolean
  INSTALL_REPO?: string
}

declare module 'qrcode' {
  export function toString(
    text: string,
    options?: Record<string, unknown>,
  ): Promise<string>
  const qrcode: {
    toString: typeof toString
  }
  export default qrcode
}

declare module 'turndown' {
  const TurndownService: any
  export default TurndownService
}

declare module 'ws' {
  const ws: any
  export default ws
}

declare module 'semver' {
  const semver: any
  export = semver
}

declare module '@anthropic-ai/orb2-agent-sdk' {
  const sdk: any
  export = sdk
}

declare module '@opentelemetry/exporter-metrics-otlp-grpc'
declare module '@opentelemetry/exporter-metrics-otlp-http'
declare module '@opentelemetry/exporter-metrics-otlp-proto'
declare module '@opentelemetry/exporter-prometheus'
declare module '@opentelemetry/exporter-logs-otlp-grpc'
declare module '@opentelemetry/exporter-logs-otlp-proto'
declare module '@opentelemetry/exporter-trace-otlp-http'
declare module '@opentelemetry/exporter-trace-otlp-proto'

interface PromiseConstructor {
  withResolvers<T>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
    reject: (reason?: unknown) => void
  }
}

type PromiseWithResolvers<T> = ReturnType<typeof Promise.withResolvers<T>>
