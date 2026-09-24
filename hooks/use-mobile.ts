import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, snapshot, () => false)
}

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}
function snapshot() { return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches }
