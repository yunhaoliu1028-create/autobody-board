import React from 'react'

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('App render failed', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 text-gray-800">
        <div className="max-w-xl rounded-xl border border-red-200 bg-white p-5 shadow-sm">
          <h1 className="text-base font-bold text-red-700">AutoBody Board could not start</h1>
          <p className="mt-2 text-sm text-gray-600">
            A startup error stopped the page from rendering. Please send this message to support.
          </p>
          <pre className="mt-3 max-h-52 overflow-auto rounded-lg bg-red-50 p-3 text-xs text-red-900 whitespace-pre-wrap">
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
